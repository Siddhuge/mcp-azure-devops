import express from "express";
import helmet from "helmet";
import cors from "cors";
import pinoHttp from "pino-http";

import { config } from "./config/env.js";
import { logger } from "./config/logger.js";
import { redactPaths } from "./config/redact.js";
import { requestId } from "./middleware/requestId.js";
import { requireAuth } from "./middleware/auth.js";
import { rateLimiter, identityLimiter, expensiveLimiter } from "./middleware/rateLimiter.js";
import { errorHandler } from "./middleware/errorHandler.js";
import logsRouter, { buildsRouter, projectsRouter } from "./routes/logs.route.js";
import { chatRouter } from "./routes/chat.route.js";
import { createMcpHttpRouter } from "./mcp/http.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { ping } from "./services/azure.service.js";
import { budgetStatus } from "./services/llm.service.js";
import { getStore } from "./store/index.js";
import {
  registry,
  httpRequestDuration,
  httpRequestsTotal,
  registerAsyncGauge,
  routeLabel,
} from "./metrics.js";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// Spend + budget gauges (scrape-time) so dashboards/alerts can compare them.
registerAsyncGauge("llm_spend_usd", "Current-month LLM spend in USD", async () => (await budgetStatus()).usd);
registerAsyncGauge("llm_budget_usd", "Configured monthly LLM budget in USD (0 = uncapped)", async () => config.llm.monthlyBudgetUsd);

/**
 * Build the Express application. Kept free of side effects (no listen) so it can
 * be imported directly in tests with supertest.
 * @returns {import("express").Express}
 */
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Trust N reverse-proxy hops so req.ip / rate-limiting use the real client IP.
  if (config.trustProxy > 0) app.set("trust proxy", config.trustProxy);

  app.use(helmet());
  app.use(cors({ origin: config.isProduction ? false : true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      redact: { paths: redactPaths, censor: "[REDACTED]" },
    }),
  );

  // ── Metrics instrumentation (records on response finish) ────────────────────
  app.use((req, res, next) => {
    const end = httpRequestDuration.startTimer();
    res.on("finish", () => {
      const labels = { method: req.method, route: routeLabel(req), status: res.statusCode };
      end(labels);
      httpRequestsTotal.inc(labels);
    });
    next();
  });

  // ── Public health/readiness probes (no auth, no rate limit) ────────────────
  app.get("/healthz", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));

  // Prometheus scrape endpoint. Unauthenticated by default (restrict at the
  // network layer); set METRICS_TOKEN to require a bearer.
  app.get("/metrics", async (req, res) => {
    if (config.metricsToken) {
      const presented = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const a = Buffer.from(presented);
      const b = Buffer.from(config.metricsToken);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).end();
    }
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  });

  app.get("/readyz", async (_req, res) => {
    const checks = { config: "ok", azure: "unknown", store: getStore().backend };
    try {
      await ping();
      checks.azure = "ok";
      res.json({ status: "ready", checks, llm: await budgetStatus() });
    } catch (err) {
      checks.azure = "error";
      logger.warn({ err: { message: err.message } }, "readiness check failed");
      res.status(503).json({ status: "not_ready", checks });
    }
  });

  // ── MCP over Streamable HTTP (bearer auth enforced inside the router) ───────
  app.use("/mcp", createMcpHttpRouter());

  // ── Chat web UI (static page is public; the /chat API is bearer-protected) ──
  app.use("/ui", express.static(publicDir));

  // ── REST + chat API (coarse IP limit, then auth + per-identity limits) ──────
  app.use(rateLimiter);
  app.use("/logs", requireAuth, identityLimiter, logsRouter);
  app.use("/builds", requireAuth, identityLimiter, buildsRouter);
  app.use("/projects", requireAuth, identityLimiter, projectsRouter);
  app.use("/chat", requireAuth, expensiveLimiter, chatRouter);

  app.get("/", (_req, res) =>
    res.json({
      name: "mcp-azure-devops",
      version: "3.0.0",
      ui: "/ui",
      docs: "/readyz, /logs/:id/classify, POST /mcp, POST /chat",
    }),
  );

  app.use(errorHandler);
  return app;
}

export default createApp;
