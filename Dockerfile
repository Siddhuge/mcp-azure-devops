# syntax=docker/dockerfile:1

# ── Build stage: install production deps from the lockfile ───────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Reproducible, no lifecycle scripts (supply-chain safety).
RUN npm ci --omit=dev --ignore-scripts

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4000

# tini = PID 1 that reaps zombies and forwards signals (clean SIGTERM shutdown).
RUN apk add --no-cache tini

WORKDIR /app

# Run as the unprivileged built-in 'node' user.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

USER node
EXPOSE 4000

# Liveness probe hits the public health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
# Default: MCP server over Streamable HTTP + REST gateway.
# Override for local stdio MCP:  docker run -i --rm --env-file .env <image> node src/mcp/stdio.js
CMD ["node", "src/server.js"]

LABEL org.opencontainers.image.title="mcp-azure-devops" \
      org.opencontainers.image.description="MCP server for Azure DevOps pipeline failure analysis (tiered rule engine + Claude Haiku)" \
      org.opencontainers.image.source="https://github.com/siddhanthuge/mcp-azure-devops"
