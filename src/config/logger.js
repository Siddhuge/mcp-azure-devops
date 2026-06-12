import pino from "pino";
import { config } from "./env.js";
import { redactPaths } from "./redact.js";

/**
 * Shared Pino logger. Pretty-prints in development, JSON in production, and
 * redacts known secret-bearing paths. MCP stdio transport must keep stdout
 * clean for the JSON-RPC protocol, so logs always go to stderr.
 */
export const logger = pino({
  level: config.logLevel,
  redact: { paths: redactPaths, censor: "[REDACTED]" },
  ...(config.isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, destination: 2 },
        },
      }),
}, config.isProduction ? pino.destination(2) : undefined);

export default logger;
