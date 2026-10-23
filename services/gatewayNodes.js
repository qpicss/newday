// Where a gateway's nodes run and how to start them: the URLs of every node (API traffic, admin
// UI, management) and the commands that start a node, with its own container name, data volume
// and host ports. Several nodes can share one Docker host: each has a port offset that is added to
// every published port (offset 1 publishes container port 8443 as host port 8444).
const IMAGE = 'oauth-server-gateway:1.0.0';
const MANAGEMENT_PORT = 9443;
const ADMIN_PORT = 9445;
const MAX_PORT_OFFSET = 1000;
const NODE_NAME = /^[A-Za-z0-9._:@-]{1,100}$/;

const slugOf = (gateway) => gateway.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'gateway';
const credentialsFileOf = (gateway) => `${slugOf(gateway)}-credentials.json`;

const hostOfUrl = (value) => {
  try {
    return new URL(value).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
};

// The host clients use to reach a node: its own, the host of its push address, or the gateway's.
const nodeHost = (gateway, node) => node.host || (node.url && hostOfUrl(node.url)) || hostOfUrl(gateway.publicUrl) || 'localhost';
const urlOf = (protocol, host, port) => `${protocol}://${host.includes(':') ? `[${host}]` : host}:${port}`;

// Handlers a node runs: those for the whole cluster and those for this node.
const handlersOf = (gateway, node) => (gateway.handlers || [])
  .filter((handler) => !handler.nodeId || (node && handler.nodeId === node.id))
  .sort((a, b) => a.port - b.port);

const adminEnabled = (gateway) => gateway.observability?.adminUi?.enabled !== false;
const isPull = (node) => node.mode === 'pull' || !node.url;

// { host, portOffset, traffic: [{ handler, scope, url, apis: [url] }], admin, management }
const nodeAddresses = (gateway, node, apis = []) => {
  const host = nodeHost(gateway, node);
  const offset = node.portOffset || 0;
  return {
    host,
    portOffset: offset,
    traffic: handlersOf(gateway, node).map((handler) => {
      const url = urlOf(handler.protocol, host, handler.port + offset);
      return { handler: handler.name, scope: handler.nodeId ? 'node' : 'cluster', url, apis: apis.map((api) => ({ name: api.name, url: `${url}${api.basePath}` })) };
    }),
    admin: adminEnabled(gateway) ? urlOf('https', host, ADMIN_PORT + offset) : null,
    management: isPull(node) ? null : node.url,
  };
};

// The address clients use for the whole cluster (a load balancer, or the only node).
const clusterAddresses = (gateway, apis = []) => {
  const base = String(gateway.publicUrl || '').replace(/\/+$/, '');
  return { url: base, apis: apis.map((api) => ({ name: api.name, url: `${base}${api.basePath}` })) };
};

// Container ports a node publishes: management (push nodes), the admin UI and its handlers.
const containerPorts = (gateway, node, { pull }) => [
  ...(pull ? [] : [MANAGEMENT_PORT]),
  ...(adminEnabled(gateway) ? [ADMIN_PORT] : []),
  ...handlersOf(gateway, node && node.id ? node : null).map((handler) => handler.port),
];

// Host ports the nodes on `host` use already (except `exceptNodeId`).
const usedHostPorts = (gateway, host, exceptNodeId = null) => {
  const used = new Set();
  for (const node of gateway.nodes || []) {
    if (node.id === exceptNodeId || nodeHost(gateway, node) !== host) continue;
    for (const port of containerPorts(gateway, node, { pull: isPull(node) })) used.add(port + (node.portOffset || 0));
  }
  return used;
};

// The smallest offset that gives a new node on `host` host ports no other node there uses.
const nextPortOffset = (gateway, host, { pull = true } = {}) => {
  const used = usedHostPorts(gateway, host);
  const ports = containerPorts(gateway, null, { pull });
  for (let offset = 0; offset <= MAX_PORT_OFFSET; offset += 1) {
    if (ports.every((port) => !used.has(port + offset) && port + offset <= 65535)) return offset;
  }
  return null;
};

// A name for the next node that no node of the gateway uses yet.
const nextNodeName = (gateway) => {
  const names = new Set((gateway.nodes || []).map((node) => node.name));
  let index = 1;
  while (names.has(`${slugOf(gateway)}-node-${index}`)) index += 1;
  return `${slugOf(gateway)}-node-${index}`;
};

// True when the console link address only works on the console's own machine.
const isLocalUrl = (value) => ['localhost', '127.0.0.1', '::1'].includes(hostOfUrl(value || ''));

// Inside a container "localhost" is the container itself, so it reaches the console through the Docker host.
const dockerLinkUrlOf = (linkUrl) => {
  try {
    const parsed = new URL(linkUrl);
    if (['localhost', '127.0.0.1'].includes(parsed.hostname)) {
      parsed.hostname = 'host.docker.internal';
      return parsed.toString().replace(/\/+$/, '');
    }
  } catch {
    // keep the configured address
  }
  return linkUrl;
};

// What to copy to a server before running deploy/install.sh there: [{ path, note }].
const serverFiles = (credentialsFile) => [
  { path: 'gateway/package.json, gateway/package-lock.json', note: 'the gateway project and its locked dependencies' },
  { path: 'gateway/src/, gateway/ui/', note: 'the runtime and the admin UI' },
  { path: 'gateway/deploy/install.sh, gateway.env.example, oauth-gateway.service', note: 'the installer, default settings and systemd unit' },
  { path: credentialsFile, note: 'next to the gateway folder. It holds the private key: copy it securely and delete other copies' },
];

// Commands that start `node` (a saved node, or { name, portOffset, mode } for the first one), one
// per shell: [{ id, shell, label, hint, text }]. `link`: { enabled, url } of the console link.
const runCommands = (gateway, node, link, { idPrefix = 'run' } = {}) => {
  const pull = Boolean(link?.enabled && link.url) && isPull(node);
  const offset = node.portOffset || 0;
  const credentialsFile = credentialsFileOf(gateway);
  const ports = containerPorts(gateway, node, { pull });
  const dockerLinkUrl = pull ? dockerLinkUrlOf(link.url) : null;
  const args = [
    `docker run -d --name ${node.name} --restart unless-stopped`,
    ports.map((port) => `-p ${port + offset}:${port}`).join(' '),
    ...(pull && dockerLinkUrl !== link.url ? ['--add-host=host.docker.internal:host-gateway'] : []),
    ...(pull ? [`-e GATEWAY_MANAGEMENT_URL=${dockerLinkUrl}`] : []),
    `-e GATEWAY_NODE_NAME=${node.name}`,
    null,
    `-v ${node.name}-data:/data`,
    IMAGE,
  ].filter((arg) => arg !== '');
  // The same command for each shell: line continuation and the current folder differ.
  const docker = (continuation, folder) => args
    .map((arg) => (arg === null ? `-v "${folder}${credentialsFile}:/etc/oauth-gateway/credentials.json:ro"` : arg))
    .join(` ${continuation}\n  `);
  const linux = [
    'chmod +x gateway/deploy/install.sh',
    'sudo ./gateway/deploy/install.sh',
    `sudo install -m 600 -o oauth-gateway ${credentialsFile} /etc/oauth-gateway/credentials.json`,
    `echo "GATEWAY_NODE_NAME=${node.name}" | sudo tee -a /etc/oauth-gateway/gateway.env`,
    ...(pull ? [`echo "GATEWAY_MANAGEMENT_URL=${link.url}" | sudo tee -a /etc/oauth-gateway/gateway.env`] : []),
    'sudo systemctl enable --now oauth-gateway',
  ].join('\n');
  const linuxHint = `Without Docker, on Ubuntu 22.04 or 24.04: run these in the folder that holds the gateway folder and ${credentialsFile}.${offset ? ' A Linux service listens on the ports as configured, without the offset, so run it on a server of its own.' : ''}`;
  const dockerHint = `On another machine, build the image there first: copy the gateway folder and run docker build -t ${IMAGE} gateway.`;
  return [
    { id: `${idPrefix}-powershell`, shell: 'powershell', label: 'Windows PowerShell', hint: dockerHint, text: docker('`', '${PWD}\\') },
    { id: `${idPrefix}-cmd`, shell: 'cmd', label: 'Command Prompt', hint: dockerHint, text: docker('^', '%cd%\\') },
    { id: `${idPrefix}-bash`, shell: 'bash', label: 'macOS / Linux', hint: dockerHint, text: docker('\\', '$PWD/') },
    { id: `${idPrefix}-linux`, shell: 'systemd', label: 'Linux service', hint: linuxHint, files: serverFiles(credentialsFile), text: linux },
  ];
};

module.exports = {
  IMAGE,
  MANAGEMENT_PORT,
  ADMIN_PORT,
  MAX_PORT_OFFSET,
  NODE_NAME,
  slugOf,
  credentialsFileOf,
  isLocalUrl,
  nodeHost,
  handlersOf,
  isPull,
  containerPorts,
  usedHostPorts,
  nodeAddresses,
  clusterAddresses,
  nextPortOffset,
  nextNodeName,
  dockerLinkUrlOf,
  runCommands,
};
