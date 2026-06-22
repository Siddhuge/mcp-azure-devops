import dotenv from "dotenv";
import Joi from "joi";
import { loadFileSecrets } from "./secrets.js";

dotenv.config();
// Resolve any `*_FILE` secret references (K8s/Docker secrets, Vault, cloud mounts).
loadFileSecrets(["AZURE_PAT", "ANTHROPIC_API_KEY", "API_TOKENS", "METRICS_TOKEN"]);

const csv = Joi.string()
  .allow("")
  .custom((value) =>
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = Joi.object({
  NODE_ENV: Joi.string()
    .valid("development", "test", "production")
    .default("development"),
  LOG_LEVEL: Joi.string()
    .valid("fatal", "error", "warn", "info", "debug", "trace", "silent")
    .default("info"),

  // HTTP
  PORT: Joi.number().port().default(4000),
  // Named service tokens: "name:secret,name2:secret2" (bare "secret" → name "default").
  API_TOKENS: csv.default([]),
  // Number of trusted reverse-proxy hops (Express `trust proxy`). Set to the
  // count of proxies/load balancers in front of the app so client IPs and
  // rate-limiting work correctly. 0 = don't trust any proxy.
  TRUST_PROXY: Joi.number().integer().min(0).default(0),

  // OIDC/JWT auth (any IdP — Entra ID, Okta, Auth0…). Enabled when OIDC_ISSUER set.
  OIDC_ISSUER: Joi.string().allow("").default(""),
  OIDC_JWKS_URL: Joi.string().allow("").default(""), // optional; derived from issuer if blank
  OIDC_AUDIENCE: Joi.string().allow("").default(""),
  OIDC_REQUIRED_SCOPE: Joi.string().allow("").default(""),

  // Optional bearer token to protect /metrics (blank = unauthenticated, like /healthz).
  METRICS_TOKEN: Joi.string().allow("").default(""),

  // Azure DevOps
  AZURE_ORG: Joi.string().required(),
  // Optional default project. When set, requests that omit a project use it;
  // requests may target any project in the org by passing one explicitly.
  AZURE_PROJECT: Joi.string().allow("").default(""),
  AZURE_PAT: Joi.string().required(),
  // Max concurrent Azure log fetches per build (bounds fan-out).
  AZURE_MAX_CONCURRENCY: Joi.number().integer().min(1).max(50).default(6),

  // LLM tier
  LLM_ENABLED: Joi.boolean().default(false),
  ANTHROPIC_API_KEY: Joi.string().allow("").default(""),
  LLM_MODEL: Joi.string().default("claude-haiku-4-5"),
  LLM_MAX_INPUT_LINES: Joi.number().integer().min(10).max(1000).default(120),
  LLM_MONTHLY_BUDGET_USD: Joi.number().min(0).default(25),
  // Redact secrets/PII (GUIDs, IPs, tokens, emails) from log content before it
  // is sent to the LLM. On by default — disable only if egress is acceptable.
  LLM_REDACT_INPUT: Joi.boolean().default(true),

  // Cache
  CACHE_MAX_ENTRIES: Joi.number().integer().min(1).default(500),
  CACHE_TTL_SECONDS: Joi.number().integer().min(0).default(3600),
  // Optional Redis for SHARED cache + budget across replicas. When unset, an
  // in-process store is used (correct for a single instance only).
  REDIS_URL: Joi.string().allow("").default(""),
})
  // The LLM tier needs a key to actually run; enabling it without one is a
  // config mistake we want to surface at boot rather than at request time.
  .custom((value, helpers) => {
    if (value.LLM_ENABLED && !value.ANTHROPIC_API_KEY) {
      return helpers.message(
        "ANTHROPIC_API_KEY is required when LLM_ENABLED is true",
      );
    }
    return value;
  })
  .unknown();

const { value, error } = schema.validate(process.env, {
  abortEarly: false,
  stripUnknown: false,
});

if (error) {
  const details = error.details.map((d) => `  - ${d.message}`).join("\n");
  throw new Error(`Invalid configuration:\n${details}`);
}

/**
 * Validated, typed application configuration. Import this everywhere instead of
 * reading `process.env` directly.
 */
export const config = Object.freeze({
  nodeEnv: value.NODE_ENV,
  isProduction: value.NODE_ENV === "production",
  logLevel: value.LOG_LEVEL,
  port: value.PORT,
  trustProxy: value.TRUST_PROXY,
  azure: Object.freeze({
    org: value.AZURE_ORG,
    defaultProject: value.AZURE_PROJECT,
    pat: value.AZURE_PAT,
    maxConcurrency: value.AZURE_MAX_CONCURRENCY,
  }),
  auth: Object.freeze({
    tokens: value.API_TOKENS,
    oidc: Object.freeze({
      enabled: Boolean(value.OIDC_ISSUER),
      issuer: value.OIDC_ISSUER,
      jwksUrl: value.OIDC_JWKS_URL,
      audience: value.OIDC_AUDIENCE,
      requiredScope: value.OIDC_REQUIRED_SCOPE,
    }),
  }),
  metricsToken: value.METRICS_TOKEN,
  llm: Object.freeze({
    enabled: value.LLM_ENABLED && Boolean(value.ANTHROPIC_API_KEY),
    apiKey: value.ANTHROPIC_API_KEY,
    model: value.LLM_MODEL,
    maxInputLines: value.LLM_MAX_INPUT_LINES,
    monthlyBudgetUsd: value.LLM_MONTHLY_BUDGET_USD,
    redactInput: value.LLM_REDACT_INPUT,
  }),
  cache: Object.freeze({
    maxEntries: value.CACHE_MAX_ENTRIES,
    ttlSeconds: value.CACHE_TTL_SECONDS,
  }),
  redisUrl: value.REDIS_URL,
});

export default config;
