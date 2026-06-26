# Runbook — mcp-azure-devops

Operational guide for the alerts in [`alerts.yaml`](alerts.yaml) and day-2 ops.
Dashboard: import [`grafana-dashboard.json`](grafana-dashboard.json) (uid `mcp-azure-devops`).
Signals: `/metrics` (Prometheus), `/readyz` (config + Azure + store), and the JSON
**audit log** (`event:"audit"` lines → your SIEM).

## Alerts

### McpTargetDown
- **Means:** Prometheus can't scrape any pod for 5m.
- **Check:** `kubectl -n <ns> get pods`, pod events/logs, `/healthz` and `/readyz`.
- **Likely causes:** crashloop (bad config — e.g. `LLM_ENABLED=true` with no key), image pull error, OOMKill, node issue.
- **Fix:** address the pod failure; `/readyz` shows which dependency (config/azure/store) is failing.

### McpHighErrorRate / McpHighErrorRateCritical
- **Means:** 5xx ratio >5% (warn) / >10% (crit) over 5m.
- **Check:** "Request rate by status" panel; pod logs filtered to `status>=500`; `/readyz`.
- **Likely causes:** Azure upstream failing (see McpAzureUpstreamErrors), LLM provider errors, a bug.
- **Fix:** if Azure/LLM-driven, see those sections; otherwise inspect the error `code` in logs (typed errors: `AZURE_AUTH_ERROR`, `LLM_ERROR`, …).

### McpHighLatencyP95
- **Means:** p95 request latency >2s for 10m.
- **Check:** latency panel; whether slow routes are `/chat` or `/logs/:id/classify` (LLM/Azure-bound).
- **Likely causes:** LLM latency, large builds (many log files), Azure slowness, CPU pressure (see event-loop lag).
- **Fix:** scale out (HPA/replicas); lower `AZURE_MAX_CONCURRENCY` only if Azure is rate-limiting; consider caching warm-up.

### McpAzureUpstreamErrors
- **Means:** Azure request error ratio >20% over 5m.
- **Check:** "Azure requests" panel; `/readyz` (`checks.azure`); pod logs for `AZURE_AUTH_ERROR`/`AZURE_UPSTREAM_ERROR`.
- **Likely causes:** expired/invalid **PAT**, missing scopes, Azure DevOps outage, throttling (429).
- **Fix:** rotate/repair the PAT secret (Build read + Project-and-Team read); check status.dev.azure.com; backoff already handles transient 429/5xx.

### McpLlmBudgetNearExhausted / McpLlmBudgetExhausted
- **Means:** monthly LLM spend >80% / ≥100% of `LLM_MONTHLY_BUDGET_USD`.
- **Effect at 100%:** the LLM tier short-circuits; classifications return `source: BUDGET_CAPPED` (rule engine still works — no outage, just less depth).
- **Fix:** if expected, raise `LLM_MONTHLY_BUDGET_USD`; if not, investigate spend on the "LLM cost rate" panel and the audit log (which identities/builds drove cost). Promote recurring LLM-resolved failures into free rules to cut cost.

### McpHighEventLoopLag
- **Means:** Node event-loop p99 lag >200ms for 10m (CPU pressure / blocking work).
- **Fix:** scale out; check for unusually large builds; review CPU limits/requests.

## Day-2 operations
- **Scale:** `--set autoscaling.enabled=true` (HPA), or bump `replicaCount`. With >1 replica, ensure shared **Redis** (`redis.enabled` or `redisUrl`) so the budget cap + cache are global.
- **Rotate secrets:** update the Secret (PAT / Anthropic key / API tokens); pods restart on config/secret checksum change.
- **Who did what:** the audit log records `actor`, `action`, `target`, `source`, `costUsd`, `requestId` per request.
- **Restrict /metrics:** set `METRICS_TOKEN` (the ServiceMonitor sends it as a bearer) or rely on NetworkPolicy.
