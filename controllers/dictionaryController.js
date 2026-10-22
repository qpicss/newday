// The selected organization's data dictionary: fields (the schema of one value) and objects (named
// sets of properties). Documents keep their own copy of what the designer wrote into them, so
// changing or deleting an entry here never changes an API by itself (see apiDesignController refresh).
const sequelize = require('../config/database');
const { Op } = require('sequelize');
const { Api, DictionaryField, DictionaryObject, DictionaryProperty } = require('../models');
const { sendServerError } = require('../utils/http');
const {
  validateName,
  validateFieldSchema,
  validateProperties,
  optionalDescription,
  renderField,
  renderComponents,
  describeSchema,
} = require('../utils/dictionary');
const {
  MAX_FIELDS,
  MAX_OBJECTS,
  loadDictionary,
  apiUsage,
  plainField,
  plainObject,
  importIntoDictionary,
} = require('../services/dictionary');

const orgWhere = (req, extra = {}) => ({ organizationId: req.user.organizationId, ...extra });

// Case-insensitive name check within the organization (MySQL compares names that way anyway).
const nameTaken = async (Model, req, name, exceptId = null) => {
  const rows = await Model.findAll({
    where: orgWhere(req, exceptId ? { id: { [Op.ne]: exceptId } } : {}),
    attributes: ['id', 'name'],
  });
  return rows.find((row) => row.name.toLowerCase() === name.toLowerCase()) || null;
};

const serializeField = (field, { usedBy = [], apis = [] } = {}) => ({
  ...plainField(field),
  summary: describeSchema(field.schema),
  preview: renderField(field),
  usedBy,
  apis,
});

const summarizeObject = (object, dictionary) => ({
  id: object.id,
  name: object.name,
  description: object.description,
  source: object.source,
  propertyCount: object.properties.length,
  properties: object.properties.map((property) => {
    const field = property.fieldId ? dictionary.fields.get(property.fieldId) : null;
    const target = property.refObjectId ? dictionary.objects.get(property.refObjectId) : null;
    return {
      ...property,
      kind: field ? 'field' : 'object',
      targetName: field ? field.name : target ? target.name : null,
      summary: field ? describeSchema(field.schema) : target ? target.name : 'missing',
      targetDescription: field ? field.description : target ? target.description : null,
    };
  }),
  updatedAt: object.updatedAt,
});

// Fields and objects of the organization (the designer's and the object builder's pickers).
const getDictionary = async (req, res) => {
  try {
    const dictionary = await loadDictionary(req.user.organizationId);
    res.json({
      fields: [...dictionary.fields.values()].map((field) => ({
        id: field.id,
        name: field.name,
        description: field.description,
        type: field.schema.type,
        summary: describeSchema(field.schema),
      })),
      objects: [...dictionary.objects.values()].map((object) => ({
        id: object.id,
        name: object.name,
        description: object.description,
        propertyCount: object.properties.length,
      })),
    });
  } catch (error) {
    sendServerError(res, error, 'Failed to load the dictionary');
  }
};

const readFieldBody = (body = {}, { partial = false } = {}) => {
  const fields = {};
  if (!partial || body.name !== undefined) {
    const { name, error } = validateName(body.name, 'field');
    if (error) return { error };
    fields.name = name;
  }
  if (body.description !== undefined) {
    const { value, error } = optionalDescription(body.description);
    if (error) return { error };
    fields.description = value;
  }
  if (!partial || body.schema !== undefined) {
    const { schema, error } = validateFieldSchema(body.schema);
    if (error) return { error };
    fields.schema = schema;
  }
  return { fields };
};

const createField = async (req, res) => {
  try {
    const { fields, error } = readFieldBody(req.body);
    if (error) return res.status(400).json({ error });
    if (await DictionaryField.count({ where: orgWhere(req) }) >= MAX_FIELDS) {
      return res.status(400).json({ error: `The dictionary holds at most ${MAX_FIELDS} fields` });
    }
    const taken = await nameTaken(DictionaryField, req, fields.name);
    if (taken) return res.status(409).json({ error: `The dictionary already has a field named ${taken.name}`, fieldId: taken.id });
    const field = await DictionaryField.create({ ...fields, organizationId: req.user.organizationId, source: 'manual', createdById: req.user.id });
    res.status(201).json({ field: serializeField(field) });
  } catch (error) {
    sendServerError(res, error, 'Failed to add the field');
  }
};

const findField = (req) => DictionaryField.findOne({ where: orgWhere(req, { id: req.params.id }) });

// Objects using the field as a property, and APIs using it as a parameter or body.
const fieldUsage = async (req, field) => {
  const properties = await DictionaryProperty.findAll({ where: { fieldId: field.id }, attributes: ['objectId'] });
  const objects = properties.length
    ? await DictionaryObject.findAll({ where: orgWhere(req, { id: [...new Set(properties.map((property) => property.objectId))] }), attributes: ['id', 'name'], order: [['name', 'ASC']] })
    : [];
  const { fields } = await apiUsage(req.user.organizationId);
  return { usedBy: objects.map((object) => ({ id: object.id, name: object.name })), apis: fields.get(field.id) || [] };
};

const getField = async (req, res) => {
  try {
    const field = await findField(req);
    if (!field) return res.status(404).json({ error: 'Field not found' });
    res.json({ field: serializeField(field, await fieldUsage(req, field)) });
  } catch (error) {
    sendServerError(res, error, 'Failed to load the field');
  }
};

const updateField = async (req, res) => {
  try {
    const field = await findField(req);
    if (!field) return res.status(404).json({ error: 'Field not found' });
    const { fields, error } = readFieldBody(req.body, { partial: true });
    if (error) return res.status(400).json({ error });
    if (fields.name) {
      const taken = await nameTaken(DictionaryField, req, fields.name, field.id);
      if (taken) return res.status(409).json({ error: `The dictionary already has a field named ${taken.name}` });
    }
    await field.update(fields);
    res.json({ field: serializeField(field, await fieldUsage(req, field)) });
  } catch (error) {
    sendServerError(res, error, 'Failed to save the field');
  }
};

// A field still used by objects stays: removing it would silently drop their properties.
const deleteField = async (req, res) => {
  try {
    const field = await findField(req);
    if (!field) return res.status(404).json({ error: 'Field not found' });
    const { usedBy } = await fieldUsage(req, field);
    if (usedBy.length) {
      return res.status(409).json({ error: `${field.name} is a property of ${usedBy.map((object) => object.name).join(', ')}. Remove it from ${usedBy.length === 1 ? 'that object' : 'those objects'} first.` });
    }
    await field.destroy();
    res.json({ message: 'Field deleted' });
  } catch (error) {
    sendServerError(res, error, 'Failed to delete the field');
  }
};

const readObjectBody = async (req, { partial = false } = {}) => {
  const body = req.body || {};
  const fields = {};
  if (!partial || body.name !== undefined) {
    const { name, error } = validateName(body.name, 'object');
    if (error) return { error };
    fields.name = name;
  }
  if (body.description !== undefined) {
    const { value, error } = optionalDescription(body.description);
    if (error) return { error };
    fields.description = value;
  }
  if (body.additionalProperties !== undefined) {
    if (![true, false, null].includes(body.additionalProperties)) return { error: '"additionalProperties" must be true or false' };
    fields.additionalProperties = body.additionalProperties === false ? false : null;
  }
  let properties;
  if (body.properties !== undefined) {
    const [fieldRows, objectRows] = await Promise.all([
      DictionaryField.findAll({ where: orgWhere(req), attributes: ['id'] }),
      DictionaryObject.findAll({ where: orgWhere(req), attributes: ['id'] }),
    ]);
    const objectIds = new Set(objectRows.map((row) => row.id));
    // An object may contain itself (a tree); a new one has no id yet, so it can't.
    if (req.params.id) objectIds.add(req.params.id);
    const result = validateProperties(body.properties, { fieldIds: new Set(fieldRows.map((row) => row.id)), objectIds });
    if (result.error) return { error: result.error };
    properties = result.properties;
  }
  return { fields, properties };
};

const objectResponse = async (req, objectId) => {
  const dictionary = await loadDictionary(req.user.organizationId);
  const object = dictionary.objects.get(objectId);
  const users = [...dictionary.objects.values()]
    .filter((other) => other.id !== objectId && other.properties.some((property) => property.refObjectId === objectId))
    .map((other) => ({ id: other.id, name: other.name }));
  const { objects } = await apiUsage(req.user.organizationId);
  return {
    object: {
      ...summarizeObject(object, dictionary),
      additionalProperties: object.additionalProperties,
      sourceApiId: object.sourceApiId,
      createdAt: object.createdAt,
      usedBy: users,
      apis: objects.get(objectId) || [],
      // What the object becomes in a document: it and every object it uses.
      preview: renderComponents([objectId], dictionary),
    },
  };
};

const saveProperties = (objectId, properties, transaction) => DictionaryProperty.destroy({ where: { objectId }, transaction })
  .then(() => DictionaryProperty.bulkCreate(properties.map((property) => ({ ...property, objectId })), { transaction }));

const createObject = async (req, res) => {
  try {
    const { fields, properties, error } = await readObjectBody(req);
    if (error) return res.status(400).json({ error });
    if (await DictionaryObject.count({ where: orgWhere(req) }) >= MAX_OBJECTS) {
      return res.status(400).json({ error: `The dictionary holds at most ${MAX_OBJECTS} objects` });
    }
    const taken = await nameTaken(DictionaryObject, req, fields.name);
    if (taken) return res.status(409).json({ error: `The dictionary already has an object named ${taken.name}`, objectId: taken.id });
    const object = await sequelize.transaction(async (transaction) => {
      const created = await DictionaryObject.create({ ...fields, organizationId: req.user.organizationId, source: 'manual', createdById: req.user.id }, { transaction });
      if (properties?.length) await saveProperties(created.id, properties, transaction);
      return created;
    });
    res.status(201).json(await objectResponse(req, object.id));
  } catch (error) {
    sendServerError(res, error, 'Failed to add the object');
  }
};

const findObject = (req) => DictionaryObject.findOne({ where: orgWhere(req, { id: req.params.id }) });

const getObject = async (req, res) => {
  try {
    const object = await findObject(req);
    if (!object) return res.status(404).json({ error: 'Object not found' });
    res.json(await objectResponse(req, object.id));
  } catch (error) {
    sendServerError(res, error, 'Failed to load the object');
  }
};

// properties, when sent, replace the whole list (in the order given).
const updateObject = async (req, res) => {
  try {
    const object = await findObject(req);
    if (!object) return res.status(404).json({ error: 'Object not found' });
    const { fields, properties, error } = await readObjectBody(req, { partial: true });
    if (error) return res.status(400).json({ error });
    if (fields.name) {
      const taken = await nameTaken(DictionaryObject, req, fields.name, object.id);
      if (taken) return res.status(409).json({ error: `The dictionary already has an object named ${taken.name}` });
    }
    await sequelize.transaction(async (transaction) => {
      await object.update(fields, { transaction });
      if (properties) await saveProperties(object.id, properties, transaction);
      // Saving properties alone doesn't touch the object row; its updatedAt still shows the change.
      if (properties && !object.changed()) {
        object.changed('updatedAt', true);
        await object.save({ transaction });
      }
    });
    res.json(await objectResponse(req, object.id));
  } catch (error) {
    sendServerError(res, error, 'Failed to save the object');
  }
};

const deleteObject = async (req, res) => {
  try {
    const object = await findObject(req);
    if (!object) return res.status(404).json({ error: 'Object not found' });
    const users = await DictionaryProperty.findAll({ where: { refObjectId: object.id, objectId: { [Op.ne]: object.id } }, attributes: ['objectId'] });
    if (users.length) {
      const names = await DictionaryObject.findAll({ where: orgWhere(req, { id: [...new Set(users.map((row) => row.objectId))] }), attributes: ['name'], order: [['name', 'ASC']] });
      return res.status(409).json({ error: `${object.name} is used by ${names.map((row) => row.name).join(', ')}. Remove it from ${names.length === 1 ? 'that object' : 'those objects'} first.` });
    }
    await sequelize.transaction(async (transaction) => {
      await DictionaryProperty.destroy({ where: { objectId: object.id }, transaction });
      await object.destroy({ transaction });
    });
    res.json({ message: 'Object deleted' });
  } catch (error) {
    sendServerError(res, error, 'Failed to delete the object');
  }
};

// Adds an API's schemas and parameters to the dictionary (imports do this on their own).
const importFromApi = async (req, res) => {
  try {
    const api = await Api.findOne({ where: orgWhere(req, { id: req.params.id }), attributes: ['id', 'spec'] });
    if (!api) return res.status(404).json({ error: 'API not found' });
    const result = await importIntoDictionary({ spec: api.spec, organizationId: req.user.organizationId, apiId: api.id, userId: req.user.id });
    res.json({ dictionary: result });
  } catch (error) {
    sendServerError(res, error, 'Failed to add the API to the dictionary');
  }
};

module.exports = {
  getDictionary,
  createField,
  getField,
  updateField,
  deleteField,
  createObject,
  getObject,
  updateObject,
  deleteObject,
  importFromApi,
  serializeField,
  summarizeObject,
  fieldUsage,
  objectResponse,
};
