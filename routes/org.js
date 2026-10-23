const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireOrganization, requireOrgAdmin } = require('../middleware/org');
const org = require('../controllers/orgController');
const apis = require('../controllers/apiController');
const products = require('../controllers/productController');
const policies = require('../controllers/policyController');
const deployment = require('../controllers/deploymentController');
const connections = require('../controllers/connectionController');
const dictionary = require('../controllers/dictionaryController');
const design = require('../controllers/apiDesignController');
const schemaDesign = require('../controllers/schemaDesignController');
const { autoPushAfterChanges } = require('../services/autoPush');

// Everything here is scoped to the signed-in user's organization.
router.use(authenticate, requireOrganization);

// Gateways with auto-push on are pushed shortly after any change made here.
router.use(autoPushAfterChanges);

// Organization and members (members can view, admins can change)
router.get('/', org.getOrganization);
router.put('/', requireOrgAdmin, org.updateOrganization);
router.get('/members', org.listMembers);
router.post('/members', requireOrgAdmin, org.addMember);
router.put('/members/:id', requireOrgAdmin, org.updateMember);
router.delete('/members/:id', requireOrgAdmin, org.removeMember);

// Invitations
router.get('/invitations', requireOrgAdmin, org.listInvitations);
router.post('/invitations', requireOrgAdmin, org.createInvitation);
router.post('/invitations/:id/resend', requireOrgAdmin, org.resendInvitation);
router.delete('/invitations/:id', requireOrgAdmin, org.revokeInvitation);

// APIs (OpenAPI 3.x)
router.get('/apis', requireOrgAdmin, apis.listApis);
router.post('/apis', requireOrgAdmin, apis.createApi);
router.post('/apis/import', requireOrgAdmin, apis.importApi);
router.get('/apis/:id', requireOrgAdmin, apis.getApi);
router.put('/apis/:id', requireOrgAdmin, apis.updateApi);
router.delete('/apis/:id', requireOrgAdmin, apis.deleteApi);
router.get('/apis/:id/spec', requireOrgAdmin, apis.downloadSpec);
router.post('/apis/:id/operations', requireOrgAdmin, apis.addOperation);
router.delete('/apis/:id/operations', requireOrgAdmin, apis.removeOperation);

// API designer: the whole document (source editor) or one operation (?method=&path=)
router.put('/apis/:id/spec', requireOrgAdmin, design.saveSource);
router.post('/apis/:id/spec/validate', requireOrgAdmin, design.validateSource);
router.put('/apis/:id/operations', requireOrgAdmin, design.updateOperationInfo);
router.post('/apis/:id/operations/parameters', requireOrgAdmin, design.addParameter);
router.put('/apis/:id/operations/parameters', requireOrgAdmin, design.updateParameter);
router.delete('/apis/:id/operations/parameters', requireOrgAdmin, design.removeParameter);
router.put('/apis/:id/operations/body', requireOrgAdmin, design.setRequestBody);
router.delete('/apis/:id/operations/body', requireOrgAdmin, design.removeRequestBody);
router.put('/apis/:id/operations/responses', requireOrgAdmin, design.setResponse);
router.delete('/apis/:id/operations/responses', requireOrgAdmin, design.removeResponse);
router.put('/apis/:id/operations/content-schema', requireOrgAdmin, design.updateContentSchema);
router.post('/apis/:id/operations/content-schema/move', requireOrgAdmin, design.moveContentToSchemas);
router.post('/apis/:id/components/refresh', requireOrgAdmin, design.refreshComponents);
router.post('/apis/:id/dictionary', requireOrgAdmin, dictionary.importFromApi);

// Schema designer: the document's components.schemas, one at a time
router.post('/apis/:id/schemas', requireOrgAdmin, schemaDesign.createSchema);
router.put('/apis/:id/schemas/:name', requireOrgAdmin, schemaDesign.updateSchema);
router.delete('/apis/:id/schemas/:name', requireOrgAdmin, schemaDesign.deleteSchema);
router.post('/apis/:id/schemas/:name/dictionary', requireOrgAdmin, schemaDesign.addToDictionary);

// Data dictionary: reusable fields and objects for OpenAPI documents
router.get('/dictionary', requireOrgAdmin, dictionary.getDictionary);
router.post('/dictionary/fields', requireOrgAdmin, dictionary.createField);
router.get('/dictionary/fields/:id', requireOrgAdmin, dictionary.getField);
router.put('/dictionary/fields/:id', requireOrgAdmin, dictionary.updateField);
router.delete('/dictionary/fields/:id', requireOrgAdmin, dictionary.deleteField);
router.post('/dictionary/objects', requireOrgAdmin, dictionary.createObject);
router.get('/dictionary/objects/:id', requireOrgAdmin, dictionary.getObject);
router.put('/dictionary/objects/:id', requireOrgAdmin, dictionary.updateObject);
router.delete('/dictionary/objects/:id', requireOrgAdmin, dictionary.deleteObject);

// API products
router.get('/products', requireOrgAdmin, products.listProducts);
router.post('/products', requireOrgAdmin, products.createProduct);
router.get('/products/:id', requireOrgAdmin, products.getProduct);
router.put('/products/:id', requireOrgAdmin, products.updateProduct);
router.delete('/products/:id', requireOrgAdmin, products.deleteProduct);
router.post('/products/:id/apis', requireOrgAdmin, products.addProductApi);
router.delete('/products/:id/apis/:apiId', requireOrgAdmin, products.removeProductApi);

// Access requests to this organization's products
router.get('/subscriptions', requireOrgAdmin, products.listSubscriptions);
router.put('/subscriptions/:id', requireOrgAdmin, products.decideSubscription);

// Policies (JavaScript run by gateways before calling an upstream)
router.get('/policies', requireOrgAdmin, policies.listPolicies);
router.post('/policies', requireOrgAdmin, policies.createPolicy);
router.post('/policies/test', requireOrgAdmin, policies.testPolicy);
router.get('/policies/:id', requireOrgAdmin, policies.getPolicy);
router.put('/policies/:id', requireOrgAdmin, policies.updatePolicy);
router.delete('/policies/:id', requireOrgAdmin, policies.deletePolicy);

// Connections: how gateways reach backends
router.get('/connections', requireOrgAdmin, connections.listConnections);
router.post('/connections', requireOrgAdmin, connections.createConnection);
router.get('/connections/:id', requireOrgAdmin, connections.getConnection);
router.put('/connections/:id', requireOrgAdmin, connections.updateConnection);
router.delete('/connections/:id', requireOrgAdmin, connections.deleteConnection);

// Catalogs: sets of products deployed to gateways
router.get('/catalogs', requireOrgAdmin, deployment.listCatalogs);
router.post('/catalogs', requireOrgAdmin, deployment.createCatalog);
router.put('/catalogs/:id', requireOrgAdmin, deployment.updateCatalog);
router.delete('/catalogs/:id', requireOrgAdmin, deployment.deleteCatalog);
router.post('/catalogs/:id/push', requireOrgAdmin, deployment.pushCatalog);

// Gateways, their nodes and connection handlers
router.get('/gateways', requireOrgAdmin, deployment.listGateways);
router.post('/gateways', requireOrgAdmin, deployment.createGateway);
router.get('/gateways/:id', requireOrgAdmin, deployment.getGateway);
router.put('/gateways/:id', requireOrgAdmin, deployment.updateGateway);
router.delete('/gateways/:id', requireOrgAdmin, deployment.deleteGateway);
router.post('/gateways/:id/nodes', requireOrgAdmin, deployment.addNode);
router.put('/gateways/:id/nodes/:nodeId', requireOrgAdmin, deployment.updateNode);
router.delete('/gateways/:id/nodes/:nodeId', requireOrgAdmin, deployment.removeNode);
router.post('/gateways/:id/nodes/:nodeId/admin-ticket', requireOrgAdmin, deployment.adminTicket);
router.post('/gateways/:id/handlers', requireOrgAdmin, deployment.addHandler);
router.put('/gateways/:id/handlers/:handlerId', requireOrgAdmin, deployment.updateHandler);
router.delete('/gateways/:id/handlers/:handlerId', requireOrgAdmin, deployment.removeHandler);
router.put('/gateways/:id/observability', requireOrgAdmin, deployment.updateObservability);
router.post('/gateways/:id/renew', requireOrgAdmin, deployment.renewCredentials);
router.post('/gateways/:id/credentials/:credentialId/revoke', requireOrgAdmin, deployment.revokeCredential);
router.get('/gateways/:id/requests', requireOrgAdmin, deployment.requests);
router.get('/gateways/:id/usage', requireOrgAdmin, deployment.usage);
router.get('/gateways/:id/credentials', requireOrgAdmin, deployment.downloadCredentials);
router.get('/gateways/:id/config', requireOrgAdmin, deployment.previewConfig);
router.post('/gateways/:id/push', requireOrgAdmin, deployment.push);
router.get('/gateways/:id/status', requireOrgAdmin, deployment.status);

module.exports = router;
