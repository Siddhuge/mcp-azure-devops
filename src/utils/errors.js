/**
 * Typed application errors. Each carries an HTTP `status` and a stable `code`
 * so the REST error handler and the MCP layer can map them consistently without
 * string-matching messages.
 */

export class AppError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, expose?: boolean, cause?: unknown }} [opts]
   */
  constructor(message, { status = 500, code = "INTERNAL_ERROR", expose = false, cause } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    // `expose` marks errors whose message is safe to return to the caller.
    this.expose = expose;
    if (cause !== undefined) this.cause = cause;
  }
}

export class ValidationError extends AppError {
  constructor(message, opts = {}) {
    super(message, { status: 400, code: "VALIDATION_ERROR", expose: true, ...opts });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Missing or invalid bearer token", opts = {}) {
    super(message, { status: 401, code: "UNAUTHORIZED", expose: true, ...opts });
  }
}

/** Azure rejected our PAT (often returned as an HTML sign-in page). */
export class AzureAuthError extends AppError {
  constructor(message = "Azure DevOps authentication failed — check AZURE_PAT scopes", opts = {}) {
    super(message, { status: 502, code: "AZURE_AUTH_ERROR", expose: true, ...opts });
  }
}

export class BuildNotFoundError extends AppError {
  constructor(buildId, opts = {}) {
    super(`Build '${buildId}' not found`, { status: 404, code: "BUILD_NOT_FOUND", expose: true, ...opts });
  }
}

/** Generic upstream Azure failure after retries were exhausted. */
export class AzureUpstreamError extends AppError {
  constructor(message = "Azure DevOps request failed", opts = {}) {
    super(message, { status: 502, code: "AZURE_UPSTREAM_ERROR", expose: true, ...opts });
  }
}

export class LlmError extends AppError {
  constructor(message = "LLM analysis failed", opts = {}) {
    super(message, { status: 502, code: "LLM_ERROR", expose: true, ...opts });
  }
}

export class BudgetExceededError extends AppError {
  constructor(message = "LLM monthly budget exceeded", opts = {}) {
    super(message, { status: 200, code: "BUDGET_EXCEEDED", expose: true, ...opts });
  }
}
