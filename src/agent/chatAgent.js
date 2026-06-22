import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { scrubSecrets } from "../config/redact.js";
import { redactSensitive } from "../utils/scrub.js";
import { analyzeBuild } from "../analyzer/index.js";
import {
  listProjects,
  listRecentBuilds,
  getBuildLogs,
  getLogContent,
} from "../services/azure.service.js";
import {
  getAnthropicClient,
  estimateCost,
  recordSpend,
  budgetStatus,
} from "../services/llm.service.js";
import {
  buildIdSchema,
  logContentSchema,
  listBuildsSchema,
  parseOrThrow,
} from "../schemas/logs.schema.js";
import { AppError } from "../utils/errors.js";

const log = logger.child({ module: "chatAgent" });

const MAX_ITERATIONS = 6;
const MAX_OUTPUT_TOKENS = 1024;
const MAX_TOOL_RESULT_CHARS = 8000;

const SYSTEM_PROMPT = [
  "You are an assistant for analyzing Azure DevOps CI/CD pipelines.",
  config.azure.defaultProject
    ? `The default project is "${config.azure.defaultProject}"; use it when the user doesn't name one.`
    : "There is no default project; ask the user which project if they don't name one.",
  "Use the tools to answer questions about projects, builds, and failures.",
  "When analyzing a failure, report the failureType, root cause, and fix, and mention the buildId and project.",
  "Be concise and concrete. Don't invent build IDs or results — call a tool.",
].join(" ");

/** Anthropic tool definitions (mirror the MCP tools; same underlying functions). */
const TOOLS = [
  {
    name: "list_projects",
    description: "List all projects in the Azure DevOps organization.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_recent_builds",
    description: "List recent builds in a project to find build IDs, optionally filtered by result.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        project: { type: "string", description: "Project name (defaults to the configured default)" },
        top: { type: "integer", description: "How many builds (default 20, max 100)" },
        resultFilter: { type: "string", enum: ["succeeded", "failed", "canceled", "partiallySucceeded"] },
      },
    },
  },
  {
    name: "analyze_pipeline_failure",
    description: "Analyze a failed build and return a structured root cause, fix, and severity.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        buildId: { type: "string", description: "Numeric Azure DevOps build ID" },
        project: { type: "string", description: "Project name (defaults to the configured default)" },
      },
      required: ["buildId"],
    },
  },
  {
    name: "get_build_logs",
    description: "List the log files (ids and line counts) for a build.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        buildId: { type: "string" },
        project: { type: "string" },
      },
      required: ["buildId"],
    },
  },
  {
    name: "get_log_content",
    description: "Fetch the raw text of one log file of a build (use a logId from get_build_logs).",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        buildId: { type: "string" },
        logId: { type: "string" },
        project: { type: "string" },
      },
      required: ["buildId", "logId"],
    },
  },
];

/**
 * Execute one tool call against the existing services.
 * @returns {Promise<{ text: string, isError: boolean }>}
 */
async function executeTool(name, input = {}) {
  try {
    const project = input.project ? String(input.project) : undefined;
    switch (name) {
      case "list_projects": {
        const projects = await listProjects();
        return ok(projects.map((p) => ({ id: p.id, name: p.name, state: p.state })));
      }
      case "list_recent_builds": {
        const { top, resultFilter, project: proj } = parseOrThrow(listBuildsSchema, input);
        const builds = await listRecentBuilds({ top, resultFilter, project: proj });
        return ok(
          builds.map((b) => ({
            id: b.id,
            buildNumber: b.buildNumber,
            status: b.status,
            result: b.result,
            definition: b.definition?.name,
            finishTime: b.finishTime,
          })),
        );
      }
      case "analyze_pipeline_failure": {
        const { buildId } = parseOrThrow(buildIdSchema, input);
        return ok(await analyzeBuild(buildId, project));
      }
      case "get_build_logs": {
        const { buildId } = parseOrThrow(buildIdSchema, input);
        return ok(await getBuildLogs(buildId, project));
      }
      case "get_log_content": {
        const { buildId, logId } = parseOrThrow(logContentSchema, input);
        const lines = await getLogContent(buildId, logId, project);
        return ok({ buildId, logId, lines });
      }
      default:
        return { text: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    // Return tool errors to the model so it can recover (e.g. ask for a project).
    const message = err instanceof AppError && err.expose ? err.message : "Tool execution failed";
    log.warn({ tool: name, code: err.code, message: err.message }, "chat tool error");
    return { text: message, isError: true };
  }
}

function ok(data) {
  let text = JSON.stringify(data);
  if (text.length > MAX_TOOL_RESULT_CHARS) text = text.slice(0, MAX_TOOL_RESULT_CHARS) + "…(truncated)";
  // Tool results carry Azure data (IDs, IPs, tokens) — redact before the model
  // (a third party) sees them, unless egress redaction is disabled.
  if (config.llm.redactInput) text = redactSensitive(text);
  return { text, isError: false };
}

/**
 * Run the chat agent over a conversation. Stateless: the caller passes the full
 * message history; we return the assistant reply plus a trace of tools used.
 *
 * @param {Array<{ role: "user"|"assistant", content: string }>} history
 * @returns {Promise<{ reply: string, toolCalls: Array<{name:string,input:object}>, costUsd: number }>}
 */
export async function runChat(history) {
  if ((await budgetStatus()).exceeded) {
    return {
      reply: "The monthly LLM budget has been reached, so chat is paused. Increase LLM_MONTHLY_BUDGET_USD to resume.",
      toolCalls: [],
      costUsd: 0,
    };
  }

  const client = getAnthropicClient();
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  const toolCalls = [];
  let costUsd = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let response;
    try {
      response = await client.messages.create({
        model: config.llm.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });
    } catch (err) {
      // Never leak the provider's raw error to the browser; return a friendly,
      // in-chat message so the UI shows it like any other reply.
      if (err instanceof Anthropic.AuthenticationError) {
        log.error("anthropic auth rejected (check ANTHROPIC_API_KEY)");
        return { reply: "⚠ The Anthropic API key was rejected (invalid x-api-key). Update ANTHROPIC_API_KEY and try again.", toolCalls, costUsd };
      }
      if (err instanceof Anthropic.RateLimitError) {
        return { reply: "⚠ Anthropic is rate-limiting requests right now. Please retry in a moment.", toolCalls, costUsd };
      }
      if (err instanceof Anthropic.APIError) {
        log.warn({ status: err.status }, "anthropic api error in chat");
        return { reply: `⚠ The LLM request failed (HTTP ${err.status}). Please try again.`, toolCalls, costUsd };
      }
      log.error({ message: scrubSecrets(String(err?.message || err)) }, "chat agent error");
      return { reply: "⚠ Something went wrong handling that request. Please try again.", toolCalls, costUsd };
    }
    const turnCost = estimateCost(response.usage);
    costUsd += turnCost;
    await recordSpend(turnCost);

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const reply = (response.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      return { reply: reply || "(no response)", toolCalls, costUsd };
    }

    // Execute every requested tool and feed results back.
    const toolUses = response.content.filter((b) => b.type === "tool_use");
    const results = [];
    for (const tu of toolUses) {
      toolCalls.push({ name: tu.name, input: tu.input });
      const { text, isError } = await executeTool(tu.name, tu.input);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: text, is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }

  return {
    reply: "I wasn't able to finish within the allowed number of steps. Please narrow the question.",
    toolCalls,
    costUsd,
  };
}
