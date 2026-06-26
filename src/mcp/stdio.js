#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { logger } from "../config/logger.js";

/**
 * stdio entrypoint for local MCP clients (Claude Desktop, Claude Code, MCP
 * Inspector). JSON-RPC travels over stdout/stdin, so all logging goes to stderr
 * (configured in logger.js).
 */
const log = logger.child({ module: "mcp.stdio" });

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP stdio server connected");

  const shutdown = async () => {
    log.info("shutting down MCP stdio server");
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error({ err: { message: err.message, stack: err.stack } }, "fatal MCP stdio error");
  process.exit(1);
});
