// What a gateway is loaded with wherever its configuration is built or pushed.
const { Gateway } = require('../models');

const gatewayIncludes = [
  { association: 'nodes', separate: true, order: [['createdAt', 'ASC']] },
  { association: 'handlers', separate: true, order: [['port', 'ASC']], include: [{ association: 'policy' }] },
  { association: 'catalog', attributes: ['id', 'name'] },
];

const loadGateway = (where) => Gateway.findOne({ where, include: gatewayIncludes });

module.exports = { gatewayIncludes, loadGateway };
