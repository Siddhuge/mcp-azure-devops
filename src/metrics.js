import client from "prom-client";

/**
 * Prometheus metrics registry. Vendor-neutral — scrape `GET /metrics` from
 * Prometheus/Grafana Agent/Datadog/etc. Default Node/process metrics included.
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

export const classificationTotal = new client.Counter({
  name: "classification_total",
  help: "Pipeline classifications by tier/source",
  labelNames: ["source"],
  registers: [registry],
});

export const llmCostTotal = new client.Counter({
  name: "llm_cost_usd_total",
  help: "Cumulative estimated LLM spend in USD",
  registers: [registry],
});

export const azureRequestsTotal = new client.Counter({
  name: "azure_requests_total",
  help: "Azure DevOps API requests by outcome",
  labelNames: ["outcome"],
  registers: [registry],
});

/**
 * Register a gauge whose value is computed at scrape time (e.g. current-month
 * LLM spend read from the shared store).
 * @param {string} name
 * @param {string} help
 * @param {() => Promise<number>} collect
 */
export function registerAsyncGauge(name, help, collect) {
  return new client.Gauge({
    name,
    help,
    registers: [registry],
    async collect() {
      try {
        this.set(await collect());
      } catch {
        /* leave previous value */
      }
    },
  });
}

/** Normalize a path into a low-cardinality route label (avoid unbounded series). */
export function routeLabel(req) {
  const base = (req.route && req.baseUrl + req.route.path) || req.path || "unknown";
  return base
    .replace(/\/\d+/g, "/:id")
    .replace(/\/logs\/:id\/logs\/[^/]+/, "/logs/:id/logs/:logId");
}
