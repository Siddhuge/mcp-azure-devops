import express from "express";
import helmet from "helmet";
import cors from "cors";
import pinoHttp from "pino-http";

import { config } from "./config/env.js";
import { logger } from "./config/logger.js";
import { redactPaths } from "./config/redact.js";
import { requestId } from "./middleware/requestId.js";
import { requireAuth } from "./middleware/auth.js";
import { rateLimiter } from "./middleware/rateLimiter.js";
import { errorHandler } from "./middleware/errorHandler.js";
import logsRouter, { buildsRouter, projectsRouter } from "./routes/logs.route.js";
import { createMcpHttpRouter } from "./mcp/http.js";
import { ping } from "./services/azure.service.js";
import { budgetStatus } from "./services/llm.service.js";

/**
 * Build the Express application. Kept free of side effects (no listen) so it can
 * be imported directly in tests with supertest.
 * @returns {import("express").Express}
 */
export function createApp() {
  const app = express();
  app.disable("x-powered-by");

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

  // ── Public health/readiness probes (no auth, no rate limit) ────────────────
  app.get("/healthz", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));

  app.get("/readyz", async (_req, res) => {
    const checks = { config: "ok", azure: "unknown" };
    try {
      await ping();
      checks.azure = "ok";
      res.json({ status: "ready", checks, llm: budgetStatus() });
    } catch (err) {
      checks.azure = "error";
      logger.warn({ err: { message: err.message } }, "readiness check failed");
      res.status(503).json({ status: "not_ready", checks });
    }
  });

  // ── MCP over Streamable HTTP (bearer auth enforced inside the router) ───────
  app.use("/mcp", createMcpHttpRouter());

  // ── REST API (rate limited + bearer auth) ──────────────────────────────────
  app.use(rateLimiter);
  app.use("/logs", requireAuth, logsRouter);
  app.use("/builds", requireAuth, buildsRouter);
  app.use("/projects", requireAuth, projectsRouter);

  app.get("/", (_req, res) =>
    res.json({ name: "mcp-azure-devops", version: "3.0.0", docs: "/readyz, /logs/:id/classify, POST /mcp" }),
  );

  app.use(errorHandler);
  return app;
}

export default createApp;
