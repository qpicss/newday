# OAuth Server gateway
#   docker build -t oauth-server-gateway:1.0.0 .
#   docker run -d -p 9443:9443 -p 9445:9445 -p 8443:8443 \
#     -v "$PWD/credentials.json:/etc/oauth-gateway/credentials.json:ro" -v gateway-data:/data \
#     oauth-server-gateway:1.0.0
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    GATEWAY_CREDENTIALS=/etc/oauth-gateway/credentials.json \
    GATEWAY_DATA_DIR=/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY ui ./ui

# The last configuration pushed by management is kept in /data so restarts serve traffic at once.
RUN mkdir -p /data /etc/oauth-gateway && chown node:node /data
VOLUME ["/data"]

# Runs as an unprivileged user: connection handlers should use ports >= 1024
# (publish them as 443 on the host with -p 443:8443).
USER node

# 9443: management (mTLS)  9445: admin UI (HTTPS)  9080: health checks and /metrics.
# Connection handler ports come from the console.
EXPOSE 9443 9445 9080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.GATEWAY_HEALTH_PORT || 9080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

STOPSIGNAL SIGTERM
CMD ["node", "src/index.js"]
