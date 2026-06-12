import dotenv from "dotenv";
import Joi from "joi";

dotenv.config();

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
  API_TOKENS: csv.default([]),
  // Number of trusted reverse-proxy hops (Express `trust proxy`). Set to the
  // count of proxies/load balancers in front of the app so client IPs and
  // rate-limiting work correctly. 0 = don't trust any proxy.
  TRUST_PROXY: Joi.number().integer().min(0).default(0),

  // Azure DevOps
  AZURE_ORG: Joi.string().required(),
  // Optional default project. When set, requests that omit a project use it;
  // requests may target any project in the org by passing one explicitly.
  AZURE_PROJECT: Joi.string().allow("").default(""),
  AZURE_PAT: Joi.string().required(),

  // LLM tier
  LLM_ENABLED: Joi.boolean().default(false),
  ANTHROPIC_API_KEY: Joi.string().allow("").default(""),
  LLM_MODEL: Joi.string().default("claude-haiku-4-5"),
  LLM_MAX_INPUT_LINES: Joi.number().integer().min(10).max(1000).default(120),
  LLM_MONTHLY_BUDGET_USD: Joi.number().min(0).default(25),

  // Cache
  CACHE_MAX_ENTRIES: Joi.number().integer().min(1).default(500),
  CACHE_TTL_SECONDS: Joi.number().integer().min(0).default(3600),
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
  apiTokens: value.API_TOKENS,
  trustProxy: value.TRUST_PROXY,
  azure: Object.freeze({
    org: value.AZURE_ORG,
    defaultProject: value.AZURE_PROJECT,
    pat: value.AZURE_PAT,
  }),
  llm: Object.freeze({
    enabled: value.LLM_ENABLED && Boolean(value.ANTHROPIC_API_KEY),
    apiKey: value.ANTHROPIC_API_KEY,
    model: value.LLM_MODEL,
    maxInputLines: value.LLM_MAX_INPUT_LINES,
    monthlyBudgetUsd: value.LLM_MONTHLY_BUDGET_USD,
  }),
  cache: Object.freeze({
    maxEntries: value.CACHE_MAX_ENTRIES,
    ttlSeconds: value.CACHE_TTL_SECONDS,
  }),
});

export default config;
