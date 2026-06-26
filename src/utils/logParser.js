/**
 * Log parsing/normalization utilities shared by every analyzer tier.
 */

const ERROR_MARKERS = ["##[error]", "error", "failed", "failure", "exception", "fatal"];
const WARNING_MARKERS = ["##[warning]", "warning", "deprecated", "obsolete"];
const NOISE_MARKERS = ["toomanyrequests", "rate limit", "timed out", "timeout", "denied"];

/**
 * Lines that *contain* failure keywords but are pipeline machinery / scan tables,
 * not actual failures. Dropped before classification so rules don't match on,
 * e.g., the YAML schema keyword `timeoutInMinutes` inside an expression trace or
 * the word `es-errors` inside a dependency-scan table row.
 */
const IGNORE_PATTERNS = [
  /##\[debug\]/i,
  /^\s*evaluating:/i, // Azure expression-evaluation trace
  /^\s*expanded:/i,
  /^\s*[│|]/, // box-drawing rows from scanners (trivy, npm audit, etc.)
  /node_modules\/.*package\.json/i,
  // Unexpanded pipeline variables/macros → this is script/YAML *source* being
  // echoed, not runtime output (runtime output has them substituted).
  /\$\{[A-Za-z_]/,
  /\$\([A-Za-z_]/,
  // Shell control-flow / variable-assignment source lines.
  /^\s*(while|if|elif|for|case|then|fi|do|done|esac|else)\b/,
  /;\s*(do|then)\s*$/,
  /^\s*[A-Za-z_][A-Za-z0-9_]*=\S/,
  // Azure pipeline YAML schema keys (definition, not a runtime failure).
  /^\s*(timeoutInMinutes|cancelTimeoutInMinutes|continueOnError|displayName|condition|dependsOn|pool|vmImage|demands|steps|stages|jobs|variables|trigger|strategy|maxParallel|workspace):/i,
  // Azure condition expression functions echoed from YAML.
  /^\s*(failed|succeeded|succeededOrFailed|always|canceled)\(/i,
  // Terraform plan diff rows (e.g. `- timeout = 30 -> null`, `~ tags = {...}`)
  // — these merely mention attribute names, they're not failures.
  /^\s*[-+~]\s+[\w".[\]]+\s*=/,
];

/**
 * True if a line is pipeline noise that should never drive classification.
 * @param {string} line
 * @returns {boolean}
 */
export function isNoise(line) {
  return IGNORE_PATTERNS.some((re) => re.test(line));
}

/**
 * Strip the leading Azure DevOps timestamp (`2024-01-01T00:00:00.0000000Z `) and
 * any ANSI color codes from a raw log line.
 * @param {string} line
 * @returns {string}
 */
export function stripTimestamp(line) {
  return line
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;]*m/g, "")
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*/, "")
    .trimEnd();
}

/**
 * Keep only lines that look like errors/warnings/known failure noise. This is
 * the filter applied before both rule matching and LLM submission.
 * @param {string[]} lines
 * @returns {string[]}
 */
export function filterRelevant(lines) {
  const out = [];
  for (const raw of lines) {
    const line = stripTimestamp(raw);
    if (!line) continue;
    if (isNoise(line)) continue;
    const lower = line.toLowerCase();
    if (
      ERROR_MARKERS.some((m) => lower.includes(m)) ||
      WARNING_MARKERS.some((m) => lower.includes(m)) ||
      NOISE_MARKERS.some((m) => lower.includes(m))
    ) {
      out.push(line);
    }
  }
  return out;
}

/**
 * Split filtered lines into errors vs warnings.
 * @param {string[]} lines
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function bucketize(lines) {
  const errors = [];
  const warnings = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (ERROR_MARKERS.some((m) => lower.includes(m))) errors.push(line);
    else warnings.push(line);
  }
  return { errors, warnings };
}

/**
 * Normalize a line for cache-keying: lowercase, strip volatile tokens (GUIDs,
 * hex hashes, numbers, paths) so the same failure across re-runs hashes equal.
 * @param {string} line
 * @returns {string}
 */
export function normalizeForHash(line) {
  return stripTimestamp(line)
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<guid>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hash>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deduplicate filtered lines while preserving order. Useful before LLM submission
 * since CI logs repeat the same error many times.
 * @param {string[]} lines
 * @returns {string[]}
 */
export function dedupe(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const key = normalizeForHash(line);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}
