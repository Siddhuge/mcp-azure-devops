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
| `LLM_ENABLED` | | `false` | Enable the Claude Haiku tier |
| `ANTHROPIC_API_KEY` | when LLM on | — | Anthropic API key |
| `LLM_MODEL` | | `claude-haiku-4-5` | Model id |
| `LLM_MAX_INPUT_LINES` | | `120` | Cap on log lines sent to the model |
| `LLM_MONTHLY_BUDGET_USD` | | `25` | Soft monthly spend ceiling |
| `CACHE_MAX_ENTRIES` / `CACHE_TTL_SECONDS` | | `500` / `3600` | Result cache sizing |
| `LOG_LEVEL` | | `info` | Pino log level |

---

## Security

- **Bearer auth** on all REST and MCP-HTTP routes (`API_TOKENS`), constant-time compared. Health probes stay public.
- **Secret redaction** — Azure PAT and Anthropic key are stripped from logs and error messages.
- **Helmet**, **CORS** (locked down in production), **rate limiting**, per-request IDs.
- **Bounded retries** with exponential backoff + jitter on Azure calls; only transient `429`/`5xx`/network errors retry, never `401`/`404`.
- `.env` is gitignored. **Never commit a PAT.** Run as the non-root `node` user in Docker.

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

## Docker

```bash
docker build -t mcp-azure-devops .
docker run --rm -p 4000:4000 --env-file .env mcp-azure-devops
# or:
docker compose up --build
```

The image runs as a non-root user with a `/healthz` `HEALTHCHECK`. SIGTERM drains the server gracefully.

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
