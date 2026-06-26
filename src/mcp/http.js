import { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { requireAuth } from "../middleware/auth.js";
import { logger } from "../config/logger.js";

const log = logger.child({ module: "mcp.http" });

/**
 * Express router exposing the MCP server over Streamable HTTP at POST /.
 *
 * Runs in stateless mode: a fresh server + transport is created per request and
 * torn down when the response closes. This keeps the deployment horizontally
 * scalable (no sticky sessions) at the cost of per-request server setup, which
 * is negligible here. Mounted behind bearer auth.
 *
 * @returns {Router}
 */
export function createMcpHttpRouter() {
  const router = Router();

  router.post("/", requireAuth, async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error({ err: { message: err.message } }, "MCP HTTP request failed");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode does not support server-initiated streams or session deletion.
  const methodNotAllowed = (_req, res) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless MCP HTTP)" },
      id: null,
    });
  router.get("/", methodNotAllowed);
  router.delete("/", methodNotAllowed);

  return router;
}
