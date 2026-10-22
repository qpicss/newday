#!/usr/bin/env node
// Entry point for `npm start`, the Docker image and the systemd service.
const { createGateway } = require('./gateway');

let gateway;
try {
  gateway = createGateway();
} catch (error) {
  console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', message: error.message }));
  process.exit(1);
}

gateway.start().catch((error) => {
  console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', message: `Gateway failed to start: ${error.message}` }));
  process.exit(1);
});

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    gateway.stop().finally(() => process.exit(0));
  });
}
