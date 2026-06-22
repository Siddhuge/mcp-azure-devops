import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { getAllLogLines, getTimelineIssues } from "../services/azure.service.js";
import { analyzeWithLlm, llmAvailable, budgetStatus } from "../services/llm.service.js";
import { hashLines } from "../utils/cache.js";
import { getStore } from "../store/index.js";
import { filterRelevant, bucketize, dedupe, normalizeForHash } from "../utils/logParser.js";
import { runRules } from "../utils/ruleEngine.js";

const log = logger.child({ module: "analyzer" });

// Escalate to the LLM only when the rule engine is below this confidence.
const RULE_CONFIDENCE_FLOOR = 0.6;

const store = getStore();

/**
 * @typedef {Object} Classification
 * @property {string} failureType
 * @property {string} rootCause
 * @property {string} fix
 * @property {"HIGH"|"MEDIUM"|"LOW"} severity
 * @property {number} confidence
 * @property {"RULE_ENGINE"|"CACHE"|"LLM"|"BUDGET_CAPPED"|"FALLBACK"} source
 * @property {{ totalLines: number, filteredLines: number, costUsd?: number }} meta
 */

function ruleResult(match) {
  const { rule, matchedLine } = match;
  return {
    failureType: rule.failureType,
    rootCause: matchedLine,
    fix: rule.fix,
    severity: rule.severity,
    confidence: rule.confidence,
    source: "RULE_ENGINE",
  };
}

function fallbackResult(errors, source = "FALLBACK") {
  return {
    failureType: "UNKNOWN",
    rootCause: errors[0] || "No clear error found in logs",
    fix: "Review the full build logs manually to identify the failure.",
    severity: "LOW",
    confidence: 0.3,
    source,
  };
}

/**
 * Classify an already-fetched set of log lines through the tiered pipeline.
 * Separated from fetching so it is trivially unit-testable.
 *
 * Timeline issues (when provided) are authoritative — they're structured Azure
 * errors, so they bypass the log noise filter and are matched first.
 *
 * @param {string[]} allLines
 * @param {{ timelineErrors?: string[], timelineWarnings?: string[] }} [opts]
 * @returns {Promise<Classification>}
 */
export async function classifyLines(allLines, { timelineErrors = [], timelineWarnings = [] } = {}) {
  const filtered = filterRelevant(allLines);
  const meta = {
    totalLines: allLines.length,
    filteredLines: filtered.length,
    timelineIssues: timelineErrors.length + timelineWarnings.length,
  };
  const { errors, warnings } = bucketize(filtered);
  // Timeline errors lead — they're the cleanest signal and cover failures that
  // never appear in step logs (e.g. no agent available).
  const allErrors = [...timelineErrors, ...errors];
  const allWarnings = [...timelineWarnings, ...warnings];

  // Tier 1 — rule engine (free, deterministic).
  const match = runRules(allErrors, allWarnings);
  if (match && match.rule.confidence >= RULE_CONFIDENCE_FLOOR) {
    log.debug({ rule: match.rule.name }, "classified by rule engine");
    return { ...ruleResult(match), meta };
  }

  // Tier 2 — result cache (free on repeat). Keyed by normalized signal lines.
  const deduped = dedupe([...timelineErrors, ...filtered]);
  const cacheKey = hashLines(deduped.map(normalizeForHash));
  const cached = await store.cacheGet(cacheKey);
  if (cached) {
    log.debug("cache hit");
    return { ...cached, source: "CACHE", meta };
  }

  // Tier 3 — Claude Haiku (only when enabled and under budget).
  if (deduped.length > 0 && (await llmAvailable())) {
    try {
      const llm = await analyzeWithLlm(deduped);
      const result = {
        failureType: llm.failureType,
        rootCause: llm.rootCause,
        fix: llm.fix,
        severity: llm.severity,
        confidence: llm.confidence,
        source: "LLM",
      };
      await store.cacheSet(cacheKey, result, config.cache.ttlSeconds);
      return { ...result, meta: { ...meta, costUsd: llm.costUsd } };
    } catch (err) {
      // LLM failure must never break analysis — degrade to deterministic output.
      log.warn({ err: { message: err.message, code: err.code } }, "llm tier failed, degrading");
    }
  }

  // No LLM (disabled / no key / budget capped / failed) — best deterministic answer.
  if (match) {
    // We had a low-confidence rule match; return it rather than UNKNOWN.
    return { ...ruleResult(match), meta };
  }
  const capped = config.llm.enabled && (await budgetStatus()).exceeded;
  const fb = fallbackResult(allErrors, capped ? "BUDGET_CAPPED" : "FALLBACK");
  // Distinguish "no signal in a real log" from "no data at all" (logs purged by
  // retention, or the build failed before producing any output/timeline).
  if (allLines.length === 0 && allErrors.length === 0) {
    fb.rootCause =
      "No logs or timeline issues are available for this build (likely purged by retention, or it failed before producing output).";
  }
  return { ...fb, meta };
}

/**
 * Full pipeline: fetch a build's logs and classify the failure.
 * @param {string|number} buildId
 * @param {string} [project] target project (defaults to AZURE_PROJECT)
 * @returns {Promise<Classification>}
 */
export async function analyzeBuild(buildId, project) {
  const [allLines, timeline] = await Promise.all([
    getAllLogLines(buildId, project),
    getTimelineIssues(buildId, project).catch(() => ({ errors: [], warnings: [] })),
  ]);
  return classifyLines(allLines, {
    timelineErrors: timeline.errors,
    timelineWarnings: timeline.warnings,
  });
}

/** Exposed for tests / readiness. */
export const __store = store;
