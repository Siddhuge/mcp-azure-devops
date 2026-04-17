const { runRules } = require("../utils/ruleEngine");

// optional LLM (safe fallback if not configured)
let analyzeFailure;
try {
  ({ analyzeFailure } = require("./llm.service"));
} catch (e) {
  analyzeFailure = null;
}

exports.classify = async (parsedLogs) => {
  const { errors = [], warnings = [] } = parsedLogs;

  const matches = runRules(errors, warnings);

  if (matches.length > 0) {
    const top = matches[0];

    return {
      failureType: top.failureType,
      rootCause: top.matchedLine,
      fix: top.fix,
      severity: top.severity,
      confidence: 0.95,
      source: "RULE_ENGINE"
    };
  }

  return {
    failureType: "UNKNOWN",
    rootCause: errors[0] || "No clear error",
    fix: "Check logs manually",
    severity: "LOW",
    confidence: 0.3,
    source: "FALLBACK"
  };
};