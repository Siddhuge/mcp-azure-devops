import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { scrubSecrets } from "../config/redact.js";
import { redactLines } from "../utils/scrub.js";
import { getStore } from "../store/index.js";
import { llmCostTotal } from "../metrics.js";
import { LlmError } from "../utils/errors.js";

const log = logger.child({ module: "llm.service" });

// Claude Haiku 4.5 pricing (USD per 1M tokens). Used only for the soft budget cap.
const PRICE_INPUT_PER_M = 1.0;
const PRICE_OUTPUT_PER_M = 5.0;
const PRICE_CACHE_READ_PER_M = 0.1;
const MAX_OUTPUT_TOKENS = 512;
const MAX_INPUT_CHARS = 12_000;

/**
 * Structured-output schema. The model is constrained to return exactly these
 * fields, so no parsing/repair is needed. (JSON Schema for structured outputs
 * disallows numeric range constraints, hence confidence is an unbounded number.)
 */
const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    failureType: { type: "string", description: "UPPER_SNAKE_CASE category, e.g. INFRA_TIMEOUT" },
    rootCause: { type: "string", description: "One-sentence root cause grounded in the logs" },
    fix: { type: "string", description: "Concrete, actionable remediation step" },
    severity: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
    confidence: { type: "number", description: "0..1 confidence in this classification" },
  },
  required: ["failureType", "rootCause", "fix", "severity", "confidence"],
};

const SYSTEM_PROMPT = [
  "You are a CI/CD pipeline failure triage expert for Azure DevOps.",
  "You receive the filtered error and warning lines from a failed build.",
  "Classify the single most likely root cause and propose one concrete fix.",
  "Ground every conclusion in the provided log lines. Do not invent details.",
  "If the logs are inconclusive, say so in rootCause and set a low confidence.",
  "Respond only via the required structured fields.",
].join(" ");

const store = getStore();

function currentMonth() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${now.getUTCMonth()}`;
}

/**
 * Estimate the USD cost of a single response from its usage block.
 * @param {{ input_tokens?: number, output_tokens?: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number }} usage
 * @returns {number}
 */
export function estimateCost(usage = {}) {
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const cacheRead = usage.cache_read_input_tokens || 0;
  const output = usage.output_tokens || 0;
  return (
    (input * PRICE_INPUT_PER_M) / 1e6 +
    (cacheRead * PRICE_CACHE_READ_PER_M) / 1e6 +
    (output * PRICE_OUTPUT_PER_M) / 1e6
  );
}

/**
 * Current month's spend vs. the configured cap, read from the shared store.
 * @returns {Promise<{ month: string, usd: number, budgetUsd: number, exceeded: boolean }>}
 */
export async function budgetStatus() {
  const month = currentMonth();
  const usd = await store.budgetGet(month);
  const budgetUsd = config.llm.monthlyBudgetUsd;
  return {
    month,
    usd: Number(usd.toFixed(6)),
    budgetUsd,
    exceeded: budgetUsd > 0 && usd >= budgetUsd,
  };
}

let _client;
/** Shared Anthropic client (used by classification and the chat agent). */
export function getAnthropicClient() {
  if (!_client) _client = new Anthropic({ apiKey: config.llm.apiKey });
  return _client;
}

/** Test seam: inject a mock Anthropic client. */
export function __setClient(mock) {
  _client = mock;
}

/**
 * Record LLM spend against the shared monthly budget.
 * @param {number} usd
 * @returns {Promise<void>}
 */
export async function recordSpend(usd) {
  llmCostTotal.inc(usd);
  await store.budgetIncr(currentMonth(), usd);
}

/** Reset the budget accumulator (tests). */
export async function __resetBudget() {
  await store.budgetReset(currentMonth());
}

/**
 * Whether the LLM tier can run right now (configured, enabled, under budget).
 * @returns {Promise<boolean>}
 */
export async function llmAvailable() {
  return config.llm.enabled && !(await budgetStatus()).exceeded;
}

/**
 * Build the bounded user content from filtered log lines.
 * @param {string[]} lines
 * @returns {string}
 */
function buildPrompt(lines) {
  let selected = lines.slice(0, config.llm.maxInputLines);
  // Redact secrets/PII before this content leaves for the third-party LLM.
  if (config.llm.redactInput) selected = redactLines(selected);
  const capped = selected.join("\n").slice(0, MAX_INPUT_CHARS);
  return `Filtered failure log lines:\n\n${capped}`;
}

/**
 * Classify a failure with Claude Haiku. Caller must check `llmAvailable()` first.
 *
 * @param {string[]} filteredLines  deduped, filtered error/warning lines
 * @returns {Promise<{ failureType: string, rootCause: string, fix: string, severity: string, confidence: number, source: "LLM", costUsd: number }>}
 */
export async function analyzeWithLlm(filteredLines) {
  try {
    const response = await getAnthropicClient().messages.create({
      model: config.llm.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      output_config: { format: { type: "json_schema", schema: RESULT_SCHEMA } },
      messages: [{ role: "user", content: buildPrompt(filteredLines) }],
    });

    const costUsd = estimateCost(response.usage);
    await recordSpend(costUsd);

    const text = (response.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new LlmError("LLM returned unparseable output", { cause: err });
    }

    log.info(
      { costUsd: Number(costUsd.toFixed(6)), failureType: parsed.failureType, usage: response.usage },
      "llm classification complete",
    );

    return {
      failureType: String(parsed.failureType),
      rootCause: String(parsed.rootCause),
      fix: String(parsed.fix),
      severity: ["HIGH", "MEDIUM", "LOW"].includes(parsed.severity) ? parsed.severity : "MEDIUM",
      confidence: clamp01(Number(parsed.confidence)),
      source: "LLM",
      costUsd,
    };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (err instanceof Anthropic.APIError) {
      log.warn({ status: err.status, message: scrubSecrets(err.message) }, "anthropic api error");
      throw new LlmError(`Anthropic API error (${err.status})`, { cause: err });
    }
    throw new LlmError(scrubSecrets(String(err?.message || err)), { cause: err });
  }
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}
