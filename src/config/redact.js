/**
 * Pino redaction config plus a string scrubber for secrets.
 *
 * Pino's `redact` only masks known object paths; raw error messages or URLs can
 * still leak a token. `scrubSecrets` is the belt-and-suspenders pass for free-text.
 */
import { config } from "./env.js";

/** Object paths Pino will replace with `[REDACTED]`. */
export const redactPaths = [
  "req.headers.authorization",
  "req.headers.Authorization",
  "headers.authorization",
  "config.azure.pat",
  "config.llm.apiKey",
  "AZURE_PAT",
  "ANTHROPIC_API_KEY",
  "pat",
  "apiKey",
  "*.pat",
  "*.apiKey",
];

/**
 * Replace any occurrence of known secret values in a string with `[REDACTED]`.
 * Used before logging Azure/LLM error text that may echo the credential.
 *
 * @param {unknown} input
 * @returns {unknown}
 */
export function scrubSecrets(input) {
  if (typeof input !== "string") return input;
  let out = input;
  const secrets = [config.azure.pat, config.llm.apiKey].filter(Boolean);
  for (const secret of secrets) {
    if (secret && out.includes(secret)) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  return out;
}
