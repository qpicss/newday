// Connection handlers are the gateway's API traffic listeners: one HTTP or HTTPS server per
// configured port. reconcile() opens, updates and closes servers so they match a new configuration
// without restarting the process. Ports that stay the same keep their open connections.
const http = require('http');
const https = require('https');
const { X509Certificate } = require('crypto');

const CLOSE_GRACE_MS = 10000;

const certificateFingerprint = (tls) => (tls ? new X509Certificate(tls.certificate).fingerprint256 : null);

const listen = (server, port, host) => new Promise((resolve, reject) => {
  const onError = (error) => {
    server.off('listening', onListening);
    reject(error);
  };
  const onListening = () => {
    server.off('error', onError);
    resolve();
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, host);
});

const closeServer = (server) => new Promise((resolve) => {
  if (!server.listening) {
    resolve();
    return;
  }
  const timer = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);
  timer.unref();
  server.close(() => {
    clearTimeout(timer);
    resolve();
  });
  server.closeIdleConnections();
});

class HandlerManager {
  constructor({ bindHost, createListener, logger }) {
    this.bindHost = bindHost;
    this.createListener = createListener;
    this.logger = logger;
    this.entries = new Map(); // port -> { handler, server, fingerprint, listening, error }
  }

  async open(handler) {
    const listener = this.createListener(handler);
    const server = handler.protocol === 'https'
      ? https.createServer({ key: handler.tls.privateKey, cert: handler.tls.certificate, minVersion: 'TLSv1.2' }, listener)
      : http.createServer(listener);
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
    server.requestTimeout = 120000;

    const entry = { handler, server, fingerprint: certificateFingerprint(handler.tls), listening: false, error: null };
    this.entries.set(handler.port, entry);
    try {
      await listen(server, handler.port, this.bindHost);
      entry.listening = true;
      this.logger.info('handler listening', { handler: handler.name, port: handler.port, protocol: handler.protocol });
    } catch (error) {
      entry.error = error.code === 'EADDRINUSE'
        ? `Port ${handler.port} is already in use on this host`
        : error.code === 'EACCES'
          ? `No permission to listen on port ${handler.port}`
          : error.message;
      this.logger.error('handler failed to listen', { handler: handler.name, port: handler.port, error: entry.error });
    }
  }

  async reconcile(handlers) {
    const wanted = new Map(handlers.map((handler) => [handler.port, handler]));

    // Close handlers that were removed, or whose protocol changed.
    for (const [port, entry] of this.entries) {
      const next = wanted.get(port);
      if (!next || next.protocol !== entry.handler.protocol || !entry.listening) {
        this.entries.delete(port);
        await closeServer(entry.server);
        if (!next) this.logger.info('handler closed', { handler: entry.handler.name, port });
      }
    }

    for (const handler of handlers) {
      const entry = this.entries.get(handler.port);
      if (!entry) {
        await this.open(handler);
        continue;
      }
      // Same port and protocol: swap the certificate in place if it changed, keep connections.
      const fingerprint = certificateFingerprint(handler.tls);
      if (handler.protocol === 'https' && fingerprint !== entry.fingerprint) {
        entry.server.setSecureContext({ key: handler.tls.privateKey, cert: handler.tls.certificate });
        entry.fingerprint = fingerprint;
      }
      entry.handler = handler;
      // The listener looks up the current handler on every request.
      entry.server.removeAllListeners('request');
      entry.server.on('request', this.createListener(handler));
    }
    return this.status();
  }

  status() {
    return [...this.entries.values()].map((entry) => ({
      name: entry.handler.name,
      port: entry.handler.port,
      protocol: entry.handler.protocol,
      listening: entry.listening,
      error: entry.error,
    }));
  }

  async closeAll() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => closeServer(entry.server)));
  }
}

module.exports = { HandlerManager };
