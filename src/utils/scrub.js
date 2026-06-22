import { scrubSecrets } from "../config/redact.js";

/**
 * Redaction rules applied to text BEFORE it is sent to the LLM (a third party).
 * Build logs routinely contain identifiers and secrets — subscription IDs,
 * service-principal/object IDs, IPs, tokens — that should not leave the
 * environment. We replace them with stable tags so the model still sees the
 * shape of the message without the sensitive value.
 *
 * Order matters: specific high-value patterns run before the broad GUID/IP ones.
 * @type {Array<[RegExp, string]>}
 */
const RULES = [
  // JWTs (e.g. AAD access tokens echoed into logs)
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "<jwt>"],
  // Common credential formats
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, "<anthropic-key>"],
  [/\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, "<github-token>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<aws-key>"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "<slack-token>"],
  // Azure Storage / Service Bus style "AccountKey=...", "SharedAccessKey=..."
  [/\b((?:Account|SharedAccess|Primary|Secondary)Key)=[^;"\s]+/gi, "$1=<redacted>"],
  // key: value / key=value secret pairs
  [
    /\b(password|passwd|pwd|secret|token|api[_-]?key|client_secret|connectionstring|sig)\b(\s*[=:]\s*)("?)[^"\s&;]{6,}\3/gi,
    "$1$2<redacted>",
  ],
  // IPv4 addresses (before email so `user@1.2.3.4` becomes `user@<ip>`)
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>"],
  [/[\w.+-]+@[\w-]+\.[\w.-]{2,}/g, "<email>"],
  // GUIDs — subscription / tenant / client / object IDs
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "<guid>"],
];

/**
 * Redact secrets/PII from a single string for safe LLM egress.
 * Always strips the configured PAT/API key first (via scrubSecrets).
 * @param {unknown} input
 * @returns {unknown}
 */
export function redactSensitive(input) {
  if (typeof input !== "string") return input;
  let out = scrubSecrets(input);
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

/**
 * Redact an array of log lines.
 * @param {string[]} lines
 * @returns {string[]}
 */
export function redactLines(lines) {
  return lines.map((l) => redactSensitive(l));
}
