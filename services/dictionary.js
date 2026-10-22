// The organization's data dictionary in the database: loading it for rendering, adding what an
// OpenAPI document holds (importIntoDictionary) and finding where entries are used.
const sequelize = require('../config/database');
const { Api, DictionaryField, DictionaryObject, DictionaryProperty } = require('../models');
const { OBJECT_MARK, FIELD_MARK, isPlainObject } = require('../utils/dictionary');
const { planImport } = require('../utils/dictionaryImport');
const { HTTP_METHODS } = require('../utils/openapi');

// Caps per organization, so one import can't grow the tables without bound.
const MAX_FIELDS = 5000;
const MAX_OBJECTS = 2000;

const plainField = (field) => ({
  id: field.id,
  name: field.name,
  description: field.description,
  schema: field.schema,
  source: field.source,
  sourceApiId: field.sourceApiId,
  createdAt: field.createdAt,
  updatedAt: field.updatedAt,
});

const plainProperty = (property) => ({
  id: property.id,
  name: property.name,
  fieldId: property.fieldId,
  refObjectId: property.refObjectId,
  isArray: property.isArray,
  required: property.required,
  position: property.position,
});

const plainObject = (object, properties = []) => ({
  id: object.id,
  name: object.name,
  description: object.description,
  additionalProperties: object.additionalProperties,
  source: object.source,
  sourceApiId: object.sourceApiId,
  createdAt: object.createdAt,
  updatedAt: object.updatedAt,
  properties: properties.map(plainProperty).sort((a, b) => a.position - b.position),
});

// Everything in the organization's dictionary, as Maps by id (the shape utils/dictionary.js renders).
const loadDictionary = async (organizationId, { transaction } = {}) => {
  const [fields, objects] = await Promise.all([
    DictionaryField.findAll({ where: { organizationId }, order: [['name', 'ASC']], transaction }),
    DictionaryObject.findAll({ where: { organizationId }, order: [['name', 'ASC']], transaction }),
  ]);
  const properties = objects.length
    ? await DictionaryProperty.findAll({ where: { objectId: objects.map((object) => object.id) }, transaction })
    : [];
  const byObject = new Map();
  for (const property of properties) {
    if (!byObject.has(property.objectId)) byObject.set(property.objectId, []);
    byObject.get(property.objectId).push(property);
  }
  return {
    fields: new Map(fields.map((field) => [field.id, plainField(field)])),
    objects: new Map(objects.map((object) => [object.id, plainObject(object, byObject.get(object.id))])),
  };
};

const findByName = (map, name) => {
  const lower = String(name).toLowerCase();
  for (const entry of map.values()) if (entry.name.toLowerCase() === lower) return entry;
  return null;
};

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Adds the document's schemas and parameters to the dictionary. Entries already there with the
// same name and content are reused; a different one with a taken name gets a name of its own.
const importIntoDictionary = async ({ spec, organizationId, apiId = null, userId = null }) => {
  const plan = planImport(spec);
  return sequelize.transaction(async (transaction) => {
    const dictionary = await loadDictionary(organizationId, { transaction });
    const notes = [...plan.notes];
    const taken = (map, name) => Boolean(findByName(map, name));
    const freeName = (map, base, extra = []) => {
      for (const candidate of [base, ...extra]) if (!taken(map, candidate)) return candidate;
      for (let suffix = 2; suffix < 1000; suffix += 1) {
        const candidate = `${base.slice(0, 95)}_${suffix}`;
        if (!taken(map, candidate)) return candidate;
      }
      return null;
    };

    // Fields: planned name -> dictionary id.
    const fieldIds = new Map();
    const newFields = [];
    let fieldsReused = 0;
    for (const planned of plan.fields) {
      const existing = findByName(dictionary.fields, planned.name);
      if (existing && sameJson(existing.schema, planned.schema)) {
        fieldIds.set(planned.name, existing.id);
        fieldsReused += 1;
        continue;
      }
      if (dictionary.fields.size >= MAX_FIELDS) {
        notes.push(`The dictionary holds at most ${MAX_FIELDS} fields; ${planned.name} and later fields were not added`);
        break;
      }
      const name = existing ? freeName(dictionary.fields, planned.qualifier ? `${planned.qualifier}.${planned.name}`.slice(0, 100) : `${planned.name}`) : planned.name;
      if (!name) continue;
      if (existing) notes.push(`The dictionary already has a different ${planned.name}, so this one was added as ${name}`);
      const record = DictionaryField.build({
        organizationId,
        name,
        description: planned.description,
        schema: planned.schema,
        source: 'import',
        sourceApiId: apiId,
        createdById: userId,
      });
      newFields.push(record);
      dictionary.fields.set(record.id, plainField(record));
      fieldIds.set(planned.name, record.id);
    }

    // Objects: names first (properties may point at any of them), then their properties.
    const objectIds = new Map();
    const newObjects = [];
    const sameStructure = (planned, existing) => {
      if (planned.properties.length !== existing.properties.length) return false;
      if ((planned.additionalProperties === false) !== (existing.additionalProperties === false)) return false;
      return planned.properties.every((property, index) => {
        const other = existing.properties[index];
        if (!other || other.name !== property.name || other.isArray !== property.isArray || other.required !== property.required) return false;
        if (property.kind === 'field') {
          const plannedField = plan.fields.find((field) => field.name === property.target);
          const otherField = other.fieldId && dictionary.fields.get(other.fieldId);
          return Boolean(plannedField && otherField && sameJson(plannedField.schema, otherField.schema));
        }
        const target = other.refObjectId && dictionary.objects.get(other.refObjectId);
        return Boolean(target && target.name.toLowerCase() === property.target.toLowerCase());
      });
    };
    let objectsReused = 0;
    for (const planned of plan.objects) {
      const existing = findByName(dictionary.objects, planned.name);
      if (existing && sameStructure(planned, existing)) {
        objectIds.set(planned.name, existing.id);
        objectsReused += 1;
        continue;
      }
      if (dictionary.objects.size >= MAX_OBJECTS) {
        notes.push(`The dictionary holds at most ${MAX_OBJECTS} objects; ${planned.name} and later objects were not added`);
        break;
      }
      const name = existing ? freeName(dictionary.objects, planned.name) : planned.name;
      if (!name) continue;
      if (existing) notes.push(`The dictionary already has a different ${planned.name} object, so this one was added as ${name}`);
      const record = DictionaryObject.build({
        organizationId,
        name,
        description: planned.description,
        additionalProperties: planned.additionalProperties === false ? false : null,
        source: 'import',
        sourceApiId: apiId,
        createdById: userId,
      });
      record.planned = planned;
      newObjects.push(record);
      dictionary.objects.set(record.id, plainObject(record));
      objectIds.set(planned.name, record.id);
    }

    const newProperties = [];
    for (const record of newObjects) {
      let position = 0;
      for (const property of record.planned.properties) {
        const fieldId = property.kind === 'field' ? fieldIds.get(property.target) : null;
        const refObjectId = property.kind === 'object' ? objectIds.get(property.target) : null;
        if (!fieldId && !refObjectId) continue;
        newProperties.push({ objectId: record.id, position, name: property.name, fieldId, refObjectId, isArray: property.isArray, required: property.required });
        position += 1;
      }
    }

    if (newFields.length) await DictionaryField.bulkCreate(newFields.map((record) => record.get({ plain: true })), { transaction });
    if (newObjects.length) {
      await DictionaryObject.bulkCreate(newObjects.map((record) => {
        const { planned, ...values } = record.get({ plain: true });
        return values;
      }), { transaction });
    }
    if (newProperties.length) await DictionaryProperty.bulkCreate(newProperties, { transaction });

    return {
      fieldsAdded: newFields.length,
      objectsAdded: newObjects.length,
      fieldsReused,
      objectsReused,
      notes: notes.slice(0, 50),
    };
  });
};

// The organization's APIs whose documents use these dictionary entries (written by the designer).
const apiUsage = async (organizationId) => {
  const apis = await Api.findAll({ where: { organizationId }, attributes: ['id', 'name', 'spec'], order: [['name', 'ASC']] });
  const objects = new Map(); // object id -> [{ id, name }]
  const fields = new Map(); // field id -> [{ id, name }]
  const add = (map, key, api) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    const list = map.get(key);
    if (!list.some((item) => item.id === api.id)) list.push({ id: api.id, name: api.name });
  };
  for (const api of apis) {
    const { spec } = api;
    for (const schema of Object.values(isPlainObject(spec?.components?.schemas) ? spec.components.schemas : {})) {
      if (isPlainObject(schema)) add(objects, schema[OBJECT_MARK], api);
    }
    for (const item of Object.values(isPlainObject(spec?.paths) ? spec.paths : {})) {
      if (!isPlainObject(item)) continue;
      const operations = HTTP_METHODS.map((method) => item[method]).filter(isPlainObject);
      for (const parameter of [item.parameters, ...operations.map((operation) => operation.parameters)].flat()) {
        if (isPlainObject(parameter)) add(fields, parameter[FIELD_MARK], api);
      }
      for (const operation of operations) {
        const contents = [operation.requestBody?.content, ...Object.values(isPlainObject(operation.responses) ? operation.responses : {}).map((response) => response?.content)];
        for (const content of contents) {
          for (const media of Object.values(isPlainObject(content) ? content : {})) if (isPlainObject(media)) add(fields, media[FIELD_MARK], api);
        }
      }
    }
  }
  return { objects, fields };
};

module.exports = {
  MAX_FIELDS,
  MAX_OBJECTS,
  loadDictionary,
  importIntoDictionary,
  apiUsage,
  plainField,
  plainObject,
  findByName,
};
