# Deploying mcp-azure-devops to Kubernetes

A vendor-neutral Helm chart lives in [`helm/mcp-azure-devops`](helm/mcp-azure-devops).
It runs the same container as `docker compose`, hardened for a cluster: non-root +
read-only rootfs + dropped caps + seccomp, liveness/readiness probes, resource
limits, optional HPA, PodDisruptionBudget, NetworkPolicy, Prometheus `ServiceMonitor`,
and secrets sourced from files (the app's `*_FILE` convention).

## Quick start (dev)

```bash
# build & load your image into the cluster first (or push to a registry)
helm upgrade --install mcp deploy/helm/mcp-azure-devops \
  --namespace mcp --create-namespace \
  --set image.repository=mcp-azure-devops --set image.tag=3.0.0 \
  --set config.AZURE_ORG=siddhanthuge --set config.AZURE_PROJECT=AzureCanary \
  --set secrets.data.AZURE_PAT=<pat> \
  --set secrets.data.API_TOKENS=ci:$(openssl rand -hex 16) \
  --set redis.enabled=true

kubectl -n mcp port-forward svc/mcp-mcp-azure-devops 4000:80
curl -s http://localhost:4000/readyz | jq
```

## Production guidance
- **Secrets**: set `secrets.create=false` and `secrets.existingSecret=<name>`; provision that
  Secret via your external-secrets operator / CSI driver / sealed-secrets. Required keys:
  `AZURE_PAT`, `ANTHROPIC_API_KEY` (if LLM on), `API_TOKENS`, `METRICS_TOKEN` (optional; empty allowed).
- **Image**: pin by digest — `--set image.digest=sha256:…` (overrides `tag`).
- **Shared state**: disable the bundled Redis (`redis.enabled=false`) and point
  `--set redisUrl=redis://<managed-redis>:6379` at an HA/managed Redis so the LLM budget cap
  and cache are shared + durable across replicas.
- **Autoscaling**: `--set autoscaling.enabled=true` (HPA on CPU/mem; `replicaCount` is ignored then).
- **Auth**: enable OIDC with `--set config.OIDC_ISSUER=… --set config.OIDC_AUDIENCE=… --set config.OIDC_JWKS_URL=…` (service tokens keep working alongside).
- **Monitoring**: `--set metrics.serviceMonitor.enabled=true` (needs the Prometheus Operator CRDs); scrapes `/metrics`.
- **Network**: `--set networkPolicy.enabled=true` (default-deny with egress to 443 + DNS + Redis; tighten egress to specific CIDRs/egress-gateway in your environment).

## Observability

`GET /metrics` (Prometheus) exposes request rate/latency, `classification_total{source}`,
`llm_cost_usd_total`, `llm_spend_usd` + `llm_budget_usd`, `azure_requests_total{outcome}`,
and Node defaults. Artifacts in [`observability/`](observability):
- **[grafana-dashboard.json](observability/grafana-dashboard.json)** — import (uid `mcp-azure-devops`); request/error/latency, classification tiers, LLM spend-vs-budget, Azure, memory.
- **[alerts.yaml](observability/alerts.yaml)** — Prometheus recording + alert rules (error rate, p95 latency, Azure errors, LLM budget, target down, event-loop lag). Load via `rule_files:`, or enable the chart's `PrometheusRule` (`--set metrics.prometheusRule.enabled=true --set metrics.prometheusRule.labels.release=<your-prom>`).
- **[RUNBOOK.md](observability/RUNBOOK.md)** — per-alert meaning + remediation + day-2 ops.

Scrape with `--set metrics.serviceMonitor.enabled=true` (Prometheus Operator). Restrict `/metrics` via `METRICS_TOKEN` or NetworkPolicy.

## Validate without a cluster
```bash
helm lint deploy/helm/mcp-azure-devops
helm template mcp deploy/helm/mcp-azure-devops | kubectl apply --dry-run=client -f -
```

See [`../SECURITY.md`](../SECURITY.md) for the supply-chain posture (pinned base digest, SBOM, Trivy gate).
