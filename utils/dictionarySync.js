// What the designer wrote into a document from the data dictionary, compared with the dictionary
// now (componentStatus), and brought up to date on request (refreshFromDictionary). Documents are
// never changed when the dictionary changes: their contracts reach gateways, so updates are explicit.
const {
  isPlainObject,
  isOpenApi31,
  renderField,
  renderComponents,
  OBJECT_MARK,
  FIELD_MARK,
} = require('./dictionary');
const { HTTP_METHODS } = require('./openapi');
const { renameSchemaRefs } = require('./openapiDesign');

const clone = (value) => JSON.parse(JSON.stringify(value));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Every parameter and media type object of the document's operations.
const eachUse = (spec, visit) => {
  for (const item of Object.values(isPlainObject(spec?.paths) ? spec.paths : {})) {
    if (!isPlainObject(item)) continue;
    const operations = HTTP_METHODS.map((method) => item[method]).filter(isPlainObject);
    for (const list of [item.parameters, ...operations.map((operation) => operation.parameters)]) {
      for (const parameter of Array.isArray(list) ? list : []) if (isPlainObject(parameter)) visit(parameter, 'parameter');
    }
    for (const operation of operations) {
      const contents = [operation.requestBody?.content, ...Object.values(isPlainObject(operation.responses) ? operation.responses : {}).map((response) => response?.content)];
      for (const content of contents) {
        for (const media of Object.values(isPlainObject(content) ? content : {})) if (isPlainObject(media)) visit(media, 'media');
      }
    }
  }
};

const fieldSchemaFor = (use, kind, field, openapi31) => {
  const schema = renderField(field, { openapi31, withDescription: kind !== 'parameter' });
  // A body set as "a list of" the field keeps its list.
  const wasList = kind === 'media' && use.schema?.type === 'array' && field.schema.type !== 'array';
  return wasList ? { type: 'array', items: schema } : schema;
};

// For the designer: each dictionary schema of the document, and whether it matches the dictionary.
const componentStatus = (spec, dictionary) => {
  const openapi31 = isOpenApi31(spec);
  const schemas = isPlainObject(spec?.components?.schemas) ? spec.components.schemas : {};
  const marked = Object.entries(schemas).filter(([, schema]) => isPlainObject(schema) && schema[OBJECT_MARK]);
  const present = marked.map(([, schema]) => schema[OBJECT_MARK]).filter((id) => dictionary.objects.has(id));
  const rendered = renderComponents(present, dictionary, { openapi31 });
  const status = {};
  for (const [name, schema] of marked) {
    const object = dictionary.objects.get(schema[OBJECT_MARK]);
    if (!object) status[name] = 'missing';
    else if (object.name !== name || !sameJson(rendered[object.name], schema)) status[name] = 'outdated';
    else status[name] = 'current';
  }
  // Objects now used by a dictionary schema but not in the document yet also call for an update.
  const missingNested = Object.keys(rendered).filter((name) => !schemas[name]);
  let outdatedUses = 0;
  eachUse(spec, (use, kind) => {
    const field = use[FIELD_MARK] && dictionary.fields.get(use[FIELD_MARK]);
    if (field && !sameJson(use.schema, fieldSchemaFor(use, kind, field, openapi31))) outdatedUses += 1;
  });
  return { status, missingNested, outdatedUses };
};

const refreshFromDictionary = (input, dictionary) => {
  const openapi31 = isOpenApi31(input);
  let spec = clone(input);
  const result = { updated: [], renamed: [], missing: [], conflicts: [], fieldsUpdated: 0 };
  const schemasOf = () => (isPlainObject(spec.components?.schemas) ? spec.components.schemas : {});

  // Objects renamed in the dictionary: move the schema and every $ref to it.
  for (const [name, schema] of Object.entries(schemasOf())) {
    if (!isPlainObject(schema) || !schema[OBJECT_MARK]) continue;
    const object = dictionary.objects.get(schema[OBJECT_MARK]);
    if (!object) {
      result.missing.push(name);
      continue;
    }
    if (object.name === name) continue;
    const occupant = schemasOf()[object.name];
    if (occupant && occupant[OBJECT_MARK] !== object.id) {
      result.conflicts.push(object.name);
      continue;
    }
    const schemas = { ...schemasOf() };
    schemas[object.name] = schemas[name];
    delete schemas[name];
    spec.components.schemas = schemas;
    spec = renameSchemaRefs(spec, name, object.name);
    result.renamed.push({ from: name, to: object.name });
  }

  const present = Object.values(schemasOf())
    .filter((schema) => isPlainObject(schema) && schema[OBJECT_MARK] && dictionary.objects.has(schema[OBJECT_MARK]))
    .map((schema) => schema[OBJECT_MARK]);
  const rendered = renderComponents(present, dictionary, { openapi31 });
  const schemas = { ...schemasOf() };
  for (const [name, schema] of Object.entries(rendered)) {
    const existing = schemas[name];
    if (isPlainObject(existing) && existing[OBJECT_MARK] !== schema[OBJECT_MARK]) {
      if (!result.conflicts.includes(name)) result.conflicts.push(name);
      continue;
    }
    if (!sameJson(existing, schema)) {
      schemas[name] = schema;
      result.updated.push(name);
    }
  }
  if (Object.keys(schemas).length) {
    spec.components = isPlainObject(spec.components) ? spec.components : {};
    spec.components.schemas = schemas;
  }

  eachUse(spec, (use, kind) => {
    const field = use[FIELD_MARK] && dictionary.fields.get(use[FIELD_MARK]);
    if (!field) return;
    const schema = fieldSchemaFor(use, kind, field, openapi31);
    if (!sameJson(use.schema, schema)) {
      use.schema = schema;
      result.fieldsUpdated += 1;
    }
  });

  return { spec, result };
};

module.exports = { componentStatus, refreshFromDictionary };
