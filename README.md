# MCP Azure DevOps — Pipeline Failure Analyzer

A **Model Context Protocol (MCP) server** that analyzes Azure DevOps pipeline failures and
returns a structured root cause, fix, and severity. It classifies failures **cheaply** — a
deterministic rule engine and a result cache handle the common cases for free, and it only
escalates to an LLM (Claude Haiku) when the rules can't confidently explain the failure.

> This is a real MCP server (speaks the protocol over **stdio** and **Streamable HTTP**),
> plus an optional REST gateway for non-MCP consumers (dashboards, curl, CI webhooks).

---

## How classification works (the cost model)

```
analyze_pipeline_failure(buildId)
        │
        ▼
  fetch + filter logs
        │
  ┌─────────────────────────── Tier 1: Rule engine ──────────────┐  cost: $0
  │ regex rules → confident match? → return (source: RULE_ENGINE) │
  └───────────────────────────────────────────────────────────────┘
        │ (no/low-confidence match)
  ┌─────────────────────────── Tier 2: Result cache ─────────────┐  cost: $0
  │ SHA-256 of normalized log lines → hit? → return (CACHE)        │
  └───────────────────────────────────────────────────────────────┘
        │ (miss)
  ┌─────────────────────────── Tier 3: Claude Haiku ─────────────┐  cost: small, capped
  │ truncated+deduped lines → structured JSON → return (LLM)       │
  │ skipped when LLM_ENABLED=false, no key, or budget exceeded     │
  └───────────────────────────────────────────────────────────────┘
```

**Why it's cost-effective**
- Most CI failures (Docker rate limits, OOM, npm/test/compile errors, timeouts) are caught
  by the **free** rule engine — no tokens spent.
- Identical failures across pipeline re-runs hit the **cache** (the key normalizes away
  timestamps/GUIDs/line numbers), so repeats cost nothing.
- When the LLM does run, it gets only the **deduped, filtered, truncated** error lines —
  never full logs — with a small `max_tokens` and a [structured-output schema](src/services/llm.service.js)
  so there's no parsing/repair round-trip.
- A soft **monthly budget** (`LLM_MONTHLY_BUDGET_USD`) short-circuits the LLM tier once spend
  is exceeded; classification degrades gracefully to the rule engine instead of failing.

---

## Quick start

```bash
npm install
cp .env.example .env   # fill in AZURE_ORG / AZURE_PROJECT / AZURE_PAT
```

Get an Azure PAT at `dev.azure.com` → User Settings → Personal access tokens → scope **Build (read)**.

### Run as an MCP server (stdio)

```bash
npm run mcp:stdio
# or inspect interactively:
npm run mcp:inspect
```

Register it with an MCP client (e.g. Claude Desktop / Claude Code) — `mcp.json`:

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-azure-devops/src/mcp/stdio.js"],
      "env": {
        "AZURE_ORG": "your-org",
        "AZURE_PROJECT": "your-project",
        "AZURE_PAT": "your-pat",
        "LLM_ENABLED": "false"
      }
    }
  }
}
```

### Run as an HTTP service (MCP-over-HTTP + REST)

```bash
npm start
```

- **MCP over Streamable HTTP:** `POST http://localhost:4000/mcp` (bearer auth)
- **REST:** `GET /logs/:buildId/classify`, `GET /logs/:buildId`, `GET /logs/:buildId/logs/:logId`, `GET /builds`, `GET /projects`
- **Probes:** `GET /healthz` (liveness), `GET /readyz` (checks config + Azure reachability)

```bash
# Default project (AZURE_PROJECT)
curl -H "Authorization: Bearer <your-api-token>" \
  http://localhost:4000/logs/99/classify | jq

# Any project in the org — add ?project=
curl -H "Authorization: Bearer <your-api-token>" \
  "http://localhost:4000/logs/308/classify?project=AzureCanary" | jq

# Discover project names
curl -H "Authorization: Bearer <your-api-token>" http://localhost:4000/projects | jq
```

> **Org-level:** Azure build IDs are unique *per project*. The server is scoped to
> the **organization** (`AZURE_ORG`), so any route or MCP tool accepts an optional
> `project` — pass it to target any project in the org, or omit it to use the
> `AZURE_PROJECT` default.

```json
{
  "failureType": "INFRA_DOCKER_RATE_LIMIT",
  "rootCause": "##[error]toomanyrequests: You have reached your pull rate limit",
  "fix": "Authenticate to Docker Hub (docker login) or pull from a private/mirrored registry.",
  "severity": "HIGH",
  "confidence": 0.95,
  "source": "RULE_ENGINE",
  "meta": { "totalLines": 1088, "filteredLines": 59 }
}
```

---

## Web chat UI

A built-in chat window lets you ask the same questions in a browser — no external
MCP client needed. Start the HTTP server (or container) and open:

```
http://localhost:4000/ui
```

On first use it asks for your API token (one of `API_TOKENS`) and remembers it in the
browser. Then just type natural language:

- *"list my projects"*
- *"show recent failed builds in AzureBlueGreen"*
- *"analyze build 318 in AzureCanary and tell me the fix"*

Under the hood, a small **agent** (Claude Haiku 4.5, via the `POST /chat` endpoint) runs
a tool-use loop over the same functions as the MCP tools. It reuses your
`ANTHROPIC_API_KEY` and the shared `LLM_MONTHLY_BUDGET_USD` cap, and each turn costs a
fraction of a cent (~$0.004). Requires `LLM_ENABLED=true`; otherwise `/chat` returns a
clear message and the rest of the server (rules-based REST/MCP) still works.

```bash
# Same thing via the API:
curl -s -X POST http://localhost:4000/chat \
  -H "Authorization: Bearer <your-api-token>" -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"list my projects"}]}' | jq
# → { "reply": "...", "toolCalls": [{"name":"list_projects",...}], "costUsd": 0.004 }
```

---

## MCP tools

All build tools accept an optional `project` (defaults to `AZURE_PROJECT`).

| Tool | Input | Returns |
|------|-------|---------|
| `analyze_pipeline_failure` | `buildId`, `project?` | Tiered classification (root cause, fix, severity, `source`, `confidence`) |
| `get_build_logs` | `buildId`, `project?` | Log file metadata for the build |
| `get_log_content` | `buildId`, `logId`, `project?` | Raw lines of one log file |
| `list_recent_builds` | `top?`, `resultFilter?`, `project?` | Recent builds (to discover failing IDs) |
| `list_projects` | — | All projects in the organization |

---

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AZURE_ORG` | ✅ | — | Azure DevOps organization |
| `AZURE_PROJECT` | | _(empty)_ | **Default** project; any request may override via `project`. If empty, `project` is required per-request. |
| `AZURE_PAT` | ✅ | — | PAT with **Build (read)** (+ **Project and Team (read)** for `/projects`) |
| `PORT` | | `4000` | HTTP port |
| `API_TOKENS` | | _(empty)_ | Comma-separated bearer tokens for REST/MCP-HTTP. **Empty disables auth — dev only.** |
| `TRUST_PROXY` | | `0` | Trusted reverse-proxy hops (set ≥1 behind an ingress/LB) |
| `LLM_ENABLED` | | `false` | Enable the Claude Haiku tier |
| `ANTHROPIC_API_KEY` | when LLM on | — | Anthropic API key |
| `LLM_MODEL` | | `claude-haiku-4-5` | Model id |
| `LLM_MAX_INPUT_LINES` | | `120` | Cap on log lines sent to the model |
| `LLM_MONTHLY_BUDGET_USD` | | `25` | Soft monthly spend ceiling (shared via Redis if set) |
| `LLM_REDACT_INPUT` | | `true` | Redact secrets/PII (GUIDs, IPs, tokens, emails) from log content before LLM egress |
| `REDIS_URL` | | _(empty)_ | Share cache + budget across replicas. Empty = in-process (single instance only) |
| `CACHE_MAX_ENTRIES` / `CACHE_TTL_SECONDS` | | `500` / `3600` | Result cache sizing |
| `LOG_LEVEL` | | `info` | Pino log level |

### Data governance & scaling
- **LLM egress redaction** — build logs contain subscription IDs, service-principal/object IDs, IPs, and tokens. With `LLM_REDACT_INPUT=true` (default) these are stripped before any content is sent to Anthropic. The deterministic rule-engine and cache tiers never call out.
- **Shared state for multiple replicas** — the result cache and the monthly budget counter live in-process by default, so with >1 replica the cost cap would be per-process and reset on restart. Set `REDIS_URL` (docker-compose wires a `redis` service automatically) to make both **shared and durable**, so the budget cap is global. `/readyz` reports the active backend (`store: memory|redis`).

---

## Security

- **Auth (dual mode)** — every REST/MCP-HTTP route requires a `Bearer` credential:
  - **Named service tokens** (`API_TOKENS=name:secret,…`) — hashed at rest, constant-time compared, used for machine-to-machine; each request is attributed to its token name.
  - **OIDC/JWT** (any IdP — Entra ID, Okta, Auth0) when `OIDC_ISSUER` is set: signature verified against the issuer's JWKS, with `iss`/`aud`/`exp` checks and optional `OIDC_REQUIRED_SCOPE` (403 if missing).
- **Secret redaction** — Azure PAT/Anthropic key stripped from logs; **LLM egress** also strips GUIDs/IPs/tokens/emails (`LLM_REDACT_INPUT`).
- **Helmet**, **CORS** (locked down in prod), **per-identity rate limiting** (stricter on the LLM paths), per-request IDs.
- **Bounded retries** (backoff+jitter, idempotent-only) and **bounded Azure fan-out** (`AZURE_MAX_CONCURRENCY`).
- **Secrets from files** — any sensitive var supports `<VAR>_FILE` (e.g. `AZURE_PAT_FILE=/run/secrets/azure_pat`) for K8s/Docker secrets, Vault, or cloud secret mounts. `.env` is gitignored.
- Runs as non-root with a read-only rootfs in the container.

## Enterprise / operations

| Concern | How |
|---------|-----|
| **Identity & authz** | Service tokens + OIDC/JWT (above); per-identity audit + rate limits |
| **Metrics** | `GET /metrics` (Prometheus): `http_request_duration_seconds`, `classification_total{source}`, `llm_cost_usd_total`, `llm_spend_usd`, `azure_requests_total`, Node defaults. Optional `METRICS_TOKEN`. |
| **Audit log** | One structured JSON line per action (`event:"audit"`) with actor, action, target, source, cost, requestId — ship stdout to your SIEM |
| **Shared state / scale** | `REDIS_URL` shares the cache + LLM budget across replicas (compose wires Redis). `/readyz` reports the backend. |
| **Data governance** | LLM-egress redaction (`LLM_REDACT_INPUT`); the rule-engine + cache tiers never call out |
| **Supply chain** | CI gates on `npm audit --omit=dev --audit-level=high` (production deps: **0 known vulns**) and a **Trivy** image scan (HIGH/CRITICAL). Remaining advisories are dev-only test tooling (vitest/vite/esbuild) and are not shipped in the image. |

> Reaching a fully certified enterprise deployment still requires *your* infra: connect your IdP (`OIDC_*`), mount real secrets (`*_FILE`), scrape `/metrics` + ship the audit log to your monitoring/SIEM, set SLOs/alerts, and run a security review. The code supports all of this; it can't self-certify.

---

## Development

```bash
npm run dev          # watch-mode HTTP server
npm test             # vitest unit + integration
npm run test:coverage
npm run lint
npm run format
```

### Adding a rule
Append a rule object to [`src/utils/ruleEngine.js`](src/utils/ruleEngine.js) (higher `priority`
is checked first; set a `confidence` ≥ 0.6 to win outright, lower to let the LLM tier refine).

---

## Run as a containerized MCP server

The image is production-hardened: multi-stage build, `npm ci` from a committed
lockfile (no install scripts), **non-root** user, **tini** as PID 1 (clean
SIGTERM), a `/healthz` `HEALTHCHECK`, read-only rootfs and `no-new-privileges`
in compose.

```bash
docker build -t mcp-azure-devops .

# Run as the MCP server (Streamable HTTP at /mcp) + REST gateway
docker run -d --name mcp-azure-devops \
  --env-file .env \
  -e API_TOKENS=$(openssl rand -hex 16) \
  -p 4000:4000 mcp-azure-devops

# or, with compose (reads .env):
docker compose up -d --build
```

Verify it's up and speaking MCP:

```bash
curl -s http://localhost:4000/healthz                 # {"status":"ok",...}
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:4000/mcp   # 401 (auth required)
```

### Connect an MCP client

**Option 1 — HTTP transport (recommended for a running container).** Point your
MCP client at the container's `/mcp` endpoint with a bearer token:

```json
{
  "mcpServers": {
    "azure-devops": {
      "type": "http",
      "url": "http://localhost:4000/mcp",
      "headers": { "Authorization": "Bearer <your-API_TOKENS-value>" }
    }
  }
}
```

**Option 2 — stdio transport (client launches the container per session).** No
ports or auth needed; the client runs the container with `-i` and talks over
stdio:

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--env-file", "/abs/path/to/.env",
               "mcp-azure-devops", "node", "src/mcp/stdio.js"]
    }
  }
}
```

> Behind a reverse proxy / ingress, set `TRUST_PROXY` to the number of proxy hops
> so client IPs and rate-limiting are correct.

The base image is pinned by digest for reproducible builds, and a CycloneDX SBOM is produced in CI (and via `npm run sbom`).

---

## Deploy to Kubernetes (Helm)

A hardened, vendor-neutral Helm chart is in [`deploy/helm/mcp-azure-devops`](deploy/helm/mcp-azure-devops) — liveness/readiness probes, non-root/read-only/seccomp pod security, resource limits, optional HPA, PodDisruptionBudget, NetworkPolicy, Prometheus `ServiceMonitor`, secrets-as-files (`*_FILE`), and an optional bundled Redis (use managed Redis in prod).

```bash
helm upgrade --install mcp deploy/helm/mcp-azure-devops -n mcp --create-namespace \
  --set config.AZURE_ORG=<org> --set config.AZURE_PROJECT=<project> \
  --set secrets.data.AZURE_PAT=<pat> --set secrets.data.API_TOKENS=ci:<token> \
  --set redis.enabled=true
```

Full options, production secrets guidance, and validation: [`deploy/README.md`](deploy/README.md). Supply-chain posture: [`SECURITY.md`](SECURITY.md).

---

## Architecture

```
src/
├── mcp/            MCP server + stdio and Streamable-HTTP transports
├── analyzer/       Tiered classification orchestrator (rules → cache → LLM)
├── services/       azure.service (Build API), llm.service (Claude Haiku)
├── utils/          ruleEngine, logParser, cache, errors
├── middleware/     auth, rateLimiter, requestId, errorHandler
├── routes/ controllers/ schemas/   REST gateway
├── config/         env (Joi), logger (Pino), redact
├── app.js          Express app factory
└── server.js       HTTP entrypoint + graceful shutdown
```

## License

MIT
