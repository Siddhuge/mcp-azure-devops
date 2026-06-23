# syntax=docker/dockerfile:1

# Base image pinned by digest for reproducible builds. To bump deliberately:
#   docker pull node:20-alpine && docker inspect --format '{{index .RepoDigests 0}}' node:20-alpine
# then update both digests below (and re-run the Trivy scan).
ARG NODE_IMAGE=node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

# ── Build stage: install production deps from the lockfile ───────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Reproducible, no lifecycle scripts (supply-chain safety).
RUN npm ci --omit=dev --ignore-scripts

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=4000

# Base-image hardening: patch OS packages, add tini (PID 1 that reaps zombies
# and forwards signals), and remove the bundled npm CLI — it's not used at
# runtime (we exec `node`) and its old transitive deps trip image scanners.
RUN apk upgrade --no-cache \
  && apk add --no-cache tini \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

# Run as the unprivileged built-in 'node' user.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
# Only package.json (for ESM "type"/metadata). The lockfile is a build-stage
# input for `npm ci`; shipping it makes scanners flag dev-only deps that aren't
# installed in this prod image (node_modules is --omit=dev).
COPY --chown=node:node package.json ./
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
