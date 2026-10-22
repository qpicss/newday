// Brings an existing database up to date with the current code:
//   Schema (applied first; MySQL can't roll DDL back):
//   - creates the Organizations, Invitations, Apis, ApiProducts, ProductApis, Subscriptions,
//     SystemKeys, Catalogs, CatalogProducts, Gateways, GatewayNodes, GatewayHandlers, Policies,
//     GatewayCredentials, Connections, UsageRecords and Memberships tables
//   - adds Users.organizationId, Users.orgRole, Apis.basePath, Apis.policyId, Apis.connectionId,
//     Gateways.autoPush/observability/offloadSecretSealed, GatewayHandlers.policyId and
//     GatewayNodes.mode/lastSeenAt/softwareVersion/certificateFingerprint
//   - makes GatewayNodes.url optional (pull nodes have no inbound address)
//   - adds Apis.catalogId, ApiProducts.catalogId and Applications.organizationId
//   - adds Policies.flow and Policies.ownerApiId; makes Policies.code optional (policies are flows)
//   Data (one transaction):
//   - Applications.clientSecret: plain text  -> SHA-256 hash (existing secrets keep working)
//   - Applications.redirectUris: plain text  -> JSON array
//   - Users.email:               trimmed and lower-cased
//   - Users without an organization get one of their own, as its admin
//   - APIs without a gateway base path get a unique one derived from their name
//   - every user gets a membership (with their role) in the organization they belong to
//   - products and APIs get the catalog that owns them: a product the catalog it was in (the oldest
//     link if it was in several), an API the catalog of its products; anything left over goes to a
//     "Default catalog" of its organization
//   - applications get the organization of their owner
//   - policies become flows (when Policies.flow is added): each script policy becomes
//     Input -> Gateway script -> Output, and every API gets a policy of its own that keeps today's
//     behavior: Input -> (its old policy's script) -> Invoke the backend -> Output. APIs without a
//     usable backend URL get the default flow, which returns the request.
//   - Invoke steps for "the API's backend" without a URL get the backend URL of their policy's API
//   - adds GatewayNodes.host and portOffset (where a node runs) and GatewayHandlers.nodeId (a handler for one node)
// Safe to re-run: anything already in the new format is skipped.
// Dry run by default; pass --apply to write the changes.
require('dotenv').config();
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const {
  User,
  Organization,
  Invitation,
  Application,
  Api,
  ApiProduct,
  ProductApi,
  Subscription,
  SystemKey,
  Catalog,
  CatalogProduct,
  Gateway,
  GatewayNode,
  GatewayHandler,
  Policy,
  GatewayCredential,
  Connection,
  UsageRecord,
  Membership,
} = require('../models');
const { slugify } = require('../utils/basePath');
const { defaultFlow, normalizeFlow, defaultConfig } = require('../gateway/src/flow');
const { parseRedirectUris } = require('../utils/validation');

const apply = process.argv.includes('--apply');
const HASHED_SECRET = /^[0-9a-f]{64}$/;

const NEW_TABLES = [
  Organization, Invitation, Api, ApiProduct, ProductApi, Subscription,
  SystemKey, Catalog, CatalogProduct, Gateway, GatewayNode, GatewayHandler, Policy,
  GatewayCredential, Connection, UsageRecord, Membership,
];
const NEW_COLUMNS = [
  [User, {
    organizationId: { type: DataTypes.UUID, allowNull: true },
    orgRole: { type: DataTypes.STRING, allowNull: false, defaultValue: 'member' },
  }],
  [Api, {
    basePath: { type: DataTypes.STRING(200), allowNull: true },
    policyId: { type: DataTypes.UUID, allowNull: true },
    connectionId: { type: DataTypes.UUID, allowNull: true },
    catalogId: { type: DataTypes.UUID, allowNull: true },
  }],
  [ApiProduct, {
    catalogId: { type: DataTypes.UUID, allowNull: true },
  }],
  [Application, {
    organizationId: { type: DataTypes.UUID, allowNull: true },
  }],
  [Gateway, {
    // Existing gateways keep pushing manually until someone turns auto-push on.
    autoPush: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    observability: { type: DataTypes.TEXT, allowNull: true },
    offloadSecretSealed: { type: DataTypes.TEXT, allowNull: true },
  }],
  [GatewayNode, {
    mode: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'push' },
    lastSeenAt: { type: DataTypes.DATE, allowNull: true },
    softwareVersion: { type: DataTypes.STRING(40), allowNull: true },
    certificateFingerprint: { type: DataTypes.STRING(128), allowNull: true },
    host: { type: DataTypes.STRING(255), allowNull: true },
    portOffset: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }],
  [GatewayHandler, {
    policyId: { type: DataTypes.UUID, allowNull: true },
    nodeId: { type: DataTypes.UUID, allowNull: true },
  }],
  [Policy, {
    flow: { type: sequelize.getDialect() === 'mysql' ? DataTypes.TEXT('long') : DataTypes.TEXT, allowNull: true },
    ownerApiId: { type: DataTypes.UUID, allowNull: true },
  }],
];
// Columns whose definition changed: [model, column, new definition].
const CHANGED_COLUMNS = [
  [GatewayNode, 'url', { type: DataTypes.STRING(2048), allowNull: true }],
  [Policy, 'code', { type: DataTypes.TEXT, allowNull: true }],
];

let existedBefore = new Set();
// "Table.column" for every column this run adds (or would add, in a dry run).
const addedColumns = new Set();
const tableExisted = (model) => existedBefore.has(model.getTableName().toLowerCase());

const isJsonArray = (raw) => {
  try {
    return Array.isArray(JSON.parse(raw));
  } catch {
    return false;
  }
};

// Returns, per table name, whether its new columns exist (now, or after --apply).
const migrateSchema = async () => {
  const queryInterface = sequelize.getQueryInterface();
  const tables = (await queryInterface.showAllTables())
    .map((table) => (typeof table === 'string' ? table : table.tableName).toLowerCase());

  existedBefore = new Set(tables);
  for (const model of NEW_TABLES) {
    if (!tables.includes(model.getTableName().toLowerCase())) {
      console.log(`  create table ${model.getTableName()}`);
      if (apply) await model.sync();
    }
  }

  const ready = {};
  for (const [model, definitions] of NEW_COLUMNS) {
    const table = model.getTableName();
    // A table created above (dry run) does not exist yet and has nothing to add.
    if (!tables.includes(table.toLowerCase())) {
      ready[table] = apply;
      continue;
    }
    const columns = await queryInterface.describeTable(table);
    let missing = 0;
    for (const [name, definition] of Object.entries(definitions)) {
      if (!columns[name]) {
        missing += 1;
        addedColumns.add(`${table}.${name}`);
        console.log(`  add column ${table}.${name}`);
        if (apply) await queryInterface.addColumn(table, name, definition);
      }
    }
    ready[table] = apply || missing === 0;
  }

  for (const [model, name, definition] of CHANGED_COLUMNS) {
    const table = model.getTableName();
    if (!tables.includes(table.toLowerCase())) continue;
    const column = (await queryInterface.describeTable(table))[name];
    if (column && column.allowNull === false && definition.allowNull) {
      console.log(`  allow NULL in ${table}.${name}`);
      if (apply) await queryInterface.changeColumn(table, name, definition);
    }
  }
  return ready;
};

const migrateApplications = async (transaction, warnings) => {
  // Only the columns used here: newer ones may not exist yet during a dry run.
  const applications = await Application.findAll({ attributes: ['id', 'name', 'clientSecret', 'redirectUris'], transaction });
  let secrets = 0;
  let uris = 0;

  for (const application of applications) {
    const changes = {};

    if (!HASHED_SECRET.test(application.clientSecret)) {
      changes.clientSecret = Application.hashSecret(application.clientSecret);
      secrets += 1;
    }

    // The model getter already reads the legacy format; the setter writes JSON.
    if (!isJsonArray(application.getDataValue('redirectUris'))) {
      changes.redirectUris = application.redirectUris;
      uris += 1;
    }

    const { error } = parseRedirectUris(application.redirectUris);
    if (error) {
      warnings.push(`Application "${application.name}" (${application.id}): ${error} - fix it on its detail page.`);
    }

    if (Object.keys(changes).length) {
      console.log(`  application "${application.name}" (${application.id}): ${Object.keys(changes).join(', ')}`);
      if (apply) {
        await application.update(changes, { transaction, silent: true });
      }
    }
  }
  return { secrets, uris };
};

const migrateUserEmails = async (transaction, warnings) => {
  const [users] = await sequelize.query('SELECT id, email FROM Users', { transaction });
  const taken = new Map(users.map((user) => [user.email.trim().toLowerCase(), []]));
  users.forEach((user) => taken.get(user.email.trim().toLowerCase()).push(user.id));
  let emails = 0;

  for (const user of users) {
    const normalized = user.email.trim().toLowerCase();
    if (normalized === user.email) continue;

    if (taken.get(normalized).length > 1) {
      warnings.push(`User ${user.id}: "${user.email}" collides with another account after lower-casing - resolve manually.`);
      continue;
    }
    console.log(`  user ${user.id}: email "${user.email}" -> "${normalized}"`);
    emails += 1;
    if (apply) {
      await sequelize.query('UPDATE Users SET email = ? WHERE id = ?', { replacements: [normalized, user.id], transaction });
    }
  }
  return { emails };
};

// Users from before organizations existed get their own. Only for databases from before memberships:
// since then a user may have left every organization.
const assignOrganizations = async (transaction, columnsReady) => {
  if (tableExisted(Membership)) return { organizations: 0 };
  const [users] = columnsReady
    ? await sequelize.query('SELECT id, name, email FROM Users WHERE organizationId IS NULL', { transaction })
    : await sequelize.query('SELECT id, name, email FROM Users', { transaction });

  for (const user of users) {
    const name = `${user.name}'s organization`.slice(0, 100);
    console.log(`  user ${user.email}: new organization "${name}" (as admin)`);
    if (apply) {
      const organization = await Organization.create({ name }, { transaction });
      await sequelize.query(
        'UPDATE Users SET organizationId = ?, orgRole = ? WHERE id = ?',
        { replacements: [organization.id, 'admin', user.id], transaction }
      );
    }
  }
  return { organizations: users.length };
};

// Gives every API a unique gateway base path within its organization.
const assignBasePaths = async (transaction, columnsReady) => {
  if (!columnsReady) {
    // Other new Apis columns may be missing; count by basePath when that column already exists.
    const [rows] = await sequelize.query('SELECT COUNT(*) AS n FROM Apis WHERE basePath IS NULL', { transaction })
      .catch(() => sequelize.query('SELECT COUNT(*) AS n FROM Apis', { transaction }))
      .catch(() => [[{ n: 0 }]]);
    if (rows[0].n) console.log(`  ${rows[0].n} API(s) will get a gateway base path`);
    return { basePaths: Number(rows[0].n) || 0 };
  }
  const [apis] = await sequelize.query('SELECT id, organizationId, name, basePath FROM Apis ORDER BY createdAt', { transaction });
  const taken = new Map();
  for (const api of apis) {
    if (!api.basePath) continue;
    if (!taken.has(api.organizationId)) taken.set(api.organizationId, new Set());
    taken.get(api.organizationId).add(api.basePath);
  }
  let count = 0;
  for (const api of apis) {
    if (api.basePath) continue;
    if (!taken.has(api.organizationId)) taken.set(api.organizationId, new Set());
    const used = taken.get(api.organizationId);
    const base = `/${slugify(api.name)}`;
    let basePath = base;
    for (let suffix = 2; used.has(basePath); suffix += 1) basePath = `${base}-${suffix}`;
    used.add(basePath);
    count += 1;
    console.log(`  API "${api.name}": base path ${basePath}`);
    if (apply) {
      await sequelize.query('UPDATE Apis SET basePath = ? WHERE id = ?', { replacements: [basePath, api.id], transaction });
    }
  }
  return { basePaths: count };
};

// One membership per user for the organization stored on the user (with the role stored there).
const createMemberships = async (transaction) => {
  const [users] = await sequelize.query('SELECT id, email, organizationId, orgRole FROM Users WHERE organizationId IS NOT NULL', { transaction });
  const existing = tableExisted(Membership)
    ? new Set((await sequelize.query('SELECT userId, organizationId FROM Memberships', { transaction }))[0]
      .map((row) => `${row.userId}|${row.organizationId}`))
    : new Set();
  let count = 0;
  for (const user of users) {
    if (existing.has(`${user.id}|${user.organizationId}`)) continue;
    const role = user.orgRole === 'admin' ? 'admin' : 'member';
    count += 1;
    console.log(`  user ${user.email}: membership as ${role}`);
    if (apply) await Membership.create({ userId: user.id, organizationId: user.organizationId, role }, { transaction });
  }
  return { memberships: count };
};

// Products and APIs belong to one catalog.
const assignCatalogs = async (transaction, warnings, apisReady, productsReady) => {
  const productSql = productsReady ? 'SELECT id, organizationId, name, catalogId FROM ApiProducts ORDER BY createdAt' : 'SELECT id, organizationId, name, NULL AS catalogId FROM ApiProducts ORDER BY createdAt';
  const apiSql = apisReady ? 'SELECT id, organizationId, name, catalogId FROM Apis ORDER BY createdAt' : 'SELECT id, organizationId, name, NULL AS catalogId FROM Apis ORDER BY createdAt';
  const [products] = await sequelize.query(productSql, { transaction });
  const [apis] = await sequelize.query(apiSql, { transaction });
  const [links] = await sequelize.query('SELECT productId, apiId FROM ProductApis', { transaction });
  const [catalogLinks] = await sequelize.query('SELECT catalogId, productId FROM CatalogProducts ORDER BY createdAt', { transaction }).catch(() => [[]]);
  const [catalogs] = await sequelize.query('SELECT id, organizationId, name FROM Catalogs', { transaction }).catch(() => [[]]);
  const catalogNames = new Map(catalogs.map((catalog) => [catalog.id, catalog.name]));

  // One "Default catalog" per organization, created only when needed.
  const defaults = new Map(catalogs.filter((catalog) => catalog.name === 'Default catalog').map((catalog) => [catalog.organizationId, catalog.id]));
  const defaultCatalog = async (organizationId) => {
    if (defaults.has(organizationId)) return defaults.get(organizationId);
    console.log(`  organization ${organizationId}: new "Default catalog"`);
    const id = apply ? (await Catalog.create({ organizationId, name: 'Default catalog', description: 'Products and APIs that were not in a catalog yet.' }, { transaction })).id : `default:${organizationId}`;
    defaults.set(organizationId, id);
    catalogNames.set(id, 'Default catalog');
    return id;
  };

  let productCount = 0;
  const productCatalog = new Map(products.filter((product) => product.catalogId).map((product) => [product.id, product.catalogId]));
  for (const product of products) {
    if (product.catalogId) continue;
    const inCatalogs = [...new Set(catalogLinks.filter((link) => link.productId === product.id).map((link) => link.catalogId))]
      .filter((catalogId) => catalogNames.has(catalogId));
    if (inCatalogs.length > 1) {
      warnings.push(`Product "${product.name}" was in ${inCatalogs.length} catalogs; it now belongs to "${catalogNames.get(inCatalogs[0])}" only. Gateways of the other catalogs stop serving it after their next push.`);
    }
    const catalogId = inCatalogs[0] || await defaultCatalog(product.organizationId);
    productCatalog.set(product.id, catalogId);
    productCount += 1;
    console.log(`  product "${product.name}": catalog "${catalogNames.get(catalogId)}"`);
    if (apply) await sequelize.query('UPDATE ApiProducts SET catalogId = ? WHERE id = ?', { replacements: [catalogId, product.id], transaction });
  }

  let apiCount = 0;
  const apiCatalog = new Map(apis.filter((api) => api.catalogId).map((api) => [api.id, api.catalogId]));
  for (const api of apis) {
    if (api.catalogId) continue;
    const fromProducts = [...new Set(links.filter((link) => link.apiId === api.id).map((link) => productCatalog.get(link.productId)).filter(Boolean))];
    if (fromProducts.length > 1) {
      warnings.push(`API "${api.name}" is used by products in ${fromProducts.length} catalogs; it now belongs to "${catalogNames.get(fromProducts[0])}". The products in the other catalogs keep it, but can't add it again once removed.`);
    }
    const catalogId = fromProducts[0] || await defaultCatalog(api.organizationId);
    apiCatalog.set(api.id, catalogId);
    apiCount += 1;
    console.log(`  API "${api.name}": catalog "${catalogNames.get(catalogId)}"`);
    if (apply) await sequelize.query('UPDATE Apis SET catalogId = ? WHERE id = ?', { replacements: [catalogId, api.id], transaction });
  }
  return { productCatalogs: productCount, apiCatalogs: apiCount };
};

// Applications belong to the organization their owner works in.
const assignApplicationOrganizations = async (transaction, columnsReady) => {
  const [rows] = await sequelize.query(
    `SELECT a.id, a.name, u.organizationId FROM Applications a JOIN Users u ON u.id = a.userId WHERE u.organizationId IS NOT NULL${columnsReady ? ' AND a.organizationId IS NULL' : ''}`,
    { transaction }
  );
  for (const row of rows) {
    if (apply) await sequelize.query('UPDATE Applications SET organizationId = ? WHERE id = ?', { replacements: [row.organizationId, row.id], transaction });
  }
  if (rows.length) console.log(`  ${rows.length} application(s) get their owner's organization`);
  return { applicationOrganizations: rows.length };
};

const isAbsoluteUrl = (value) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

// Builds a flow from a chain of steps laid out left to right.
const chainFlow = (steps) => {
  const nodes = [
    { id: 'input', type: 'input', name: 'Input', x: 40, y: 160, config: {} },
    ...steps.map((step, index) => ({ ...step, x: 300 + index * 260, y: 160 })),
  ];
  nodes.push({ id: 'output', type: 'output', name: 'Output', x: 300 + steps.length * 260, y: 160, config: {} });
  const edges = nodes.slice(0, -1).map((node, index) => ({ from: node.id, port: 'next', to: nodes[index + 1].id }));
  const { flow, error } = normalizeFlow({ nodes, edges });
  if (error) throw new Error(error);
  return flow;
};

const scriptStep = (id, name, code, timeoutMs) => ({
  id,
  type: 'script',
  name,
  config: { ...defaultConfig('script'), code: code || '', timeoutMs: Math.min(30000, Math.max(10, Number(timeoutMs) || 200)) },
});

// Policies become flows. Runs once, in the run that adds Policies.flow.
const migratePolicyFlows = async (transaction, warnings) => {
  if (!tableExisted(Policy) || !addedColumns.has(`${Policy.getTableName()}.flow`)) return { policyFlows: 0, apiPolicies: 0 };
  const [policies] = await sequelize.query('SELECT id, organizationId, name, code, timeoutMs FROM Policies', { transaction });
  const [apis] = await sequelize.query('SELECT id, organizationId, name, baseUrl, policyId FROM Apis ORDER BY createdAt', { transaction });
  const byId = new Map(policies.map((policy) => [policy.id, policy]));

  for (const policy of policies) {
    console.log(`  policy "${policy.name}": Input -> Gateway script -> Output`);
    if (apply) {
      const flow = chainFlow([scriptStep('script', 'Gateway script', policy.code, policy.timeoutMs)]);
      await sequelize.query('UPDATE Policies SET flow = ? WHERE id = ?', { replacements: [JSON.stringify(flow), policy.id], transaction });
    }
  }

  for (const api of apis) {
    const old = api.policyId ? byId.get(api.policyId) : null;
    let flow;
    let description;
    if (isAbsoluteUrl(api.baseUrl)) {
      const steps = [];
      if (old) steps.push(scriptStep('script', old.name, old.code, old.timeoutMs));
      steps.push({ id: 'backend', type: 'invoke', name: 'Call the backend', config: { ...defaultConfig('invoke'), url: api.baseUrl, appendPath: true } });
      // A script with onResponse ran on the reply too; it now does so as a step after the call.
      if (old && /onResponse/.test(old.code || '')) steps.push(scriptStep('reply', `${old.name} (response)`, old.code, old.timeoutMs));
      flow = chainFlow(steps);
      description = `Flow for ${api.name}: ${old ? `runs "${old.name}", then ` : ''}calls the backend and returns its answer.`;
      console.log(`  API "${api.name}": own policy, Input -> ${steps.map((step) => step.name).join(' -> ')} -> Output`);
    } else {
      flow = defaultFlow();
      description = `Flow for ${api.name}. It returns each request as it is until you add steps.`;
      console.log(`  API "${api.name}": own policy with the default flow (it has no usable backend URL)`);
      if (old) warnings.push(`API "${api.name}" used the policy "${old.name}" but has no usable backend URL; its new policy returns the request. Add steps on its policy page.`);
    }
    if (apply) {
      const created = await Policy.create({
        organizationId: api.organizationId,
        name: `${api.name} policy`.slice(0, 255),
        description,
        flow,
        ownerApiId: api.id,
      }, { transaction });
      await sequelize.query('UPDATE Apis SET policyId = ? WHERE id = ?', { replacements: [created.id, api.id], transaction });
    }
  }
  return { policyFlows: policies.length, apiPolicies: apis.length };
};

// The backend URL moved from the API's page into the Invoke step: "API's backend" steps without
// a URL get the URL of the API whose policy it is (its owner, or the only API using it).
const moveBackendUrls = async (transaction, policiesReady) => {
  if (!tableExisted(Policy) || !policiesReady) return { backendUrls: 0 };
  const [policies] = await sequelize.query('SELECT id, name, flow, ownerApiId FROM Policies WHERE flow IS NOT NULL', { transaction });
  const [apis] = await sequelize.query('SELECT id, name, baseUrl, policyId FROM Apis', { transaction });
  let steps = 0;
  for (const policy of policies) {
    const users = apis.filter((api) => api.policyId === policy.id);
    const owner = apis.find((api) => api.id === policy.ownerApiId) || (users.length === 1 ? users[0] : null);
    if (!owner || !isAbsoluteUrl(owner.baseUrl)) continue;
    let flow;
    try {
      flow = typeof policy.flow === 'string' ? JSON.parse(policy.flow) : policy.flow;
    } catch {
      continue;
    }
    const empty = (flow.nodes || []).filter((node) => node.type === 'invoke' && node.config && node.config.target === 'backend' && !node.config.url);
    if (!empty.length) continue;
    empty.forEach((node) => { node.config.url = owner.baseUrl; });
    steps += empty.length;
    console.log(`  policy "${policy.name}": ${empty.map((node) => `"${node.name}"`).join(', ')} get the backend URL ${owner.baseUrl}`);
    if (apply) await sequelize.query('UPDATE Policies SET flow = ? WHERE id = ?', { replacements: [JSON.stringify(flow), policy.id], transaction });
  }
  return { backendUrls: steps };
};

(async () => {
  const warnings = [];
  try {
    await sequelize.authenticate();
    console.log(`${apply ? 'Applying' : 'Dry run (pass --apply to write)'} on ${sequelize.getDialect()} database "${sequelize.config.database}"`);

    console.log('\nSchema:');
    const ready = await migrateSchema();

    console.log('\nData:');
    const totals = await sequelize.transaction(async (transaction) => ({
      ...(await migrateApplications(transaction, warnings)),
      ...(await migrateUserEmails(transaction, warnings)),
      ...(await assignOrganizations(transaction, ready[User.getTableName()])),
      ...(await assignBasePaths(transaction, ready[Api.getTableName()])),
      ...(await createMemberships(transaction)),
      ...(await assignCatalogs(transaction, warnings, ready[Api.getTableName()], ready[ApiProduct.getTableName()])),
      ...(await assignApplicationOrganizations(transaction, ready[Application.getTableName()])),
      ...(await migratePolicyFlows(transaction, warnings)),
      ...(await moveBackendUrls(transaction, ready[Policy.getTableName()])),
    }));

    console.log(`\nClient secrets hashed: ${totals.secrets}`);
    console.log(`Redirect URIs converted to JSON: ${totals.uris}`);
    console.log(`Emails normalized: ${totals.emails}`);
    console.log(`Organizations created for existing users: ${totals.organizations}`);
    console.log(`Gateway base paths assigned: ${totals.basePaths}`);
    console.log(`Memberships created: ${totals.memberships}`);
    console.log(`Products given a catalog: ${totals.productCatalogs}`);
    console.log(`APIs given a catalog: ${totals.apiCatalogs}`);
    console.log(`Applications given an organization: ${totals.applicationOrganizations}`);
    console.log(`Policies turned into flows: ${totals.policyFlows}`);
    console.log(`APIs given a policy of their own: ${totals.apiPolicies}`);
    console.log(`Invoke steps given the API's backend URL: ${totals.backendUrls}`);
    warnings.forEach((warning) => console.log(`WARNING: ${warning}`));
    if (!apply) console.log('\nNothing was written.');
  } catch (error) {
    console.error('Migration failed:', error.message);
    console.error('Data changes were rolled back. Schema changes made before the failure (new tables/columns) remain.');
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
