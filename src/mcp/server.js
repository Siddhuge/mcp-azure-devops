import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "../config/logger.js";
import { analyzeBuild } from "../analyzer/index.js";
import {
  getBuildLogs,
  getLogContent,
  listRecentBuilds,
  listProjects,
} from "../services/azure.service.js";
import { AppError } from "../utils/errors.js";

// Reusable optional `project` input. Builds are project-scoped in Azure DevOps;
// omitting this uses the configured default (AZURE_PROJECT).
const projectArg = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe("Azure DevOps project name. Defaults to the configured AZURE_PROJECT.");

const log = logger.child({ module: "mcp.server" });

/** Wrap a tool handler so thrown errors become MCP error results, not crashes. */
function tool(name, fn) {
  return async (args, extra) => {
    try {
      const data = await fn(args, extra);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const message = err instanceof AppError && err.expose ? err.message : "Tool execution failed";
      log.warn({ tool: name, code: err.code, message: err.message }, "mcp tool error");
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: { code: err.code || "ERROR", message } }) }],
      };
    }
  };
}

/**
 * Build a fully-configured MCP server exposing the Azure DevOps analysis tools.
 * A fresh instance is created per transport connection.
 * @returns {McpServer}
 */
export function createMcpServer() {
  const server = new McpServer(
    { name: "mcp-azure-devops", version: "3.0.0" },
    {
      instructions:
        "Analyze Azure DevOps pipeline failures. Use analyze_pipeline_failure with a buildId " +
        "to get a structured root cause and fix. Use list_recent_builds to discover failing build IDs.",
    },
  );

  server.registerTool(
    "analyze_pipeline_failure",
    {
      title: "Analyze pipeline failure",
      description:
        "Fetch an Azure DevOps build's logs and timeline and classify the failure (root cause, fix, severity). " +
        "Uses a deterministic rule engine first and only escalates to an LLM when needed. " +
        "Build IDs are project-scoped, so pass `project` to target any project in the org. " +
        "Call this when a build has failed and you need to know why and how to fix it.",
      inputSchema: {
        buildId: z.string().regex(/^\d+$/).describe("Azure DevOps build ID"),
        project: projectArg,
      },
    },
    tool("analyze_pipeline_failure", ({ buildId, project }) => analyzeBuild(buildId, project)),
  );

  server.registerTool(
    "get_build_logs",
    {
      title: "Get build log metadata",
      description: "List the log files (ids and line counts) available for a build.",
      inputSchema: {
        buildId: z.string().regex(/^\d+$/).describe("Azure DevOps build ID"),
        project: projectArg,
      },
    },
    tool("get_build_logs", ({ buildId, project }) => getBuildLogs(buildId, project)),
  );

  server.registerTool(
    "get_log_content",
    {
      title: "Get raw log content",
      description: "Fetch the raw text of a single log file for a build.",
      inputSchema: {
        buildId: z.string().regex(/^\d+$/).describe("Azure DevOps build ID"),
        logId: z.string().regex(/^\d+$/).describe("Log file ID from get_build_logs"),
        project: projectArg,
      },
    },
    tool("get_log_content", async ({ buildId, logId, project }) => ({
      buildId,
      logId,
      lines: await getLogContent(buildId, logId, project),
    })),
  );

  server.registerTool(
    "list_recent_builds",
    {
      title: "List recent builds",
      description: "List recent builds in a project to discover IDs, optionally filtered by result (e.g. failed).",
      inputSchema: {
        top: z.number().int().min(1).max(100).optional().describe("How many builds to return (default 20)"),
        resultFilter: z
          .enum(["succeeded", "failed", "canceled", "partiallySucceeded"])
          .optional()
          .describe("Filter by build result"),
        project: projectArg,
      },
    },
    tool("list_recent_builds", ({ top, resultFilter, project }) =>
      listRecentBuilds({ top: top ?? 20, resultFilter, project }).then((builds) =>
        builds.map((b) => ({
          id: b.id,
          buildNumber: b.buildNumber,
          status: b.status,
          result: b.result,
          definition: b.definition?.name,
          finishTime: b.finishTime,
        })),
      ),
    ),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List organization projects",
      description: "List all projects in the Azure DevOps organization (to discover project names).",
      inputSchema: {},
    },
    tool("list_projects", () =>
      listProjects().then((projects) =>
        projects.map((p) => ({ id: p.id, name: p.name, state: p.state })),
      ),
    ),
  );

  return server;
}
