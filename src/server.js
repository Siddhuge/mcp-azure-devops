import { createApp } from "./app.js";
import { config } from "./config/env.js";
import { logger } from "./config/logger.js";

const log = logger.child({ module: "server" });

const app = createApp();
const server = app.listen(config.port, () => {
  log.info(
    { port: config.port, env: config.nodeEnv, llm: config.llm.enabled, authEnabled: config.apiTokens.length > 0 },
    "HTTP server listening",
  );
  if (config.apiTokens.length === 0) {
    log.warn("API_TOKENS is empty — REST/MCP-HTTP endpoints are UNAUTHENTICATED (dev only)");
  }
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");

  const force = setTimeout(() => {
    log.error("forced shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();

  server.close((err) => {
    clearTimeout(force);
    if (err) {
      log.error({ err: { message: err.message } }, "error during shutdown");
      process.exit(1);
    }
    log.info("shutdown complete");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  log.error({ reason: String(reason) }, "unhandled rejection");
});

export { app, server };
