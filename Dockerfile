# OAuth Server console (management)
#   docker build -t oauth-console:1.0.0 .
#   docker run -d -p 3000:3000 -p 3443:3443 --env-file console.env oauth-console:1.0.0
# With MySQL and HTTPS: deploy/docker/ (docs/guides/console-docker.md).
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    DOTENV_CONFIG_QUIET=true

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY app.js server.js ./
COPY config ./config
COPY controllers ./controllers
COPY middleware ./middleware
COPY models ./models
COPY public ./public
COPY routes ./routes
COPY scripts ./scripts
COPY services ./services
COPY utils ./utils
COPY views ./views
COPY docs ./docs
# The console runs the gateway's flow and policy modules, serves its charts and its README.
COPY gateway/src ./gateway/src
COPY gateway/ui ./gateway/ui
COPY gateway/README.md ./gateway/README.md

# Everything lives in MySQL: the console writes no files.
USER node

# 3000: the console (HTTP; put HTTPS in front)  3443: the gateway link (mTLS)
EXPOSE 3000 3443

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/login').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

STOPSIGNAL SIGTERM
CMD ["node", "server.js"]
