// Set deterministic config BEFORE any src module (and its env.js) is imported.
// These override anything dotenv would load from a local .env file.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.AZURE_ORG = "test-org";
process.env.AZURE_PROJECT = "test-project";
process.env.AZURE_PAT = "test-pat-value";
process.env.API_TOKENS = "test-token";

// OIDC enabled for auth tests (JWKS is injected in-test via __setKeyResolver).
process.env.OIDC_ISSUER = "https://issuer.test/";
process.env.OIDC_AUDIENCE = "mcp-azure-devops";
process.env.OIDC_REQUIRED_SCOPE = "pipelines.read";
process.env.OIDC_CLIENT_ID = "spa-client-id";
process.env.OIDC_SCOPES = "openid profile";

process.env.LLM_ENABLED = "true";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.LLM_MODEL = "claude-haiku-4-5";
process.env.LLM_MONTHLY_BUDGET_USD = "25";
process.env.LLM_MAX_INPUT_LINES = "120";
process.env.CACHE_TTL_SECONDS = "3600";
process.env.CACHE_MAX_ENTRIES = "500";
