import { logger } from "../config/logger.js";
import { scrubSecrets } from "../config/redact.js";
import { AppError } from "../utils/errors.js";

const log = logger.child({ module: "errorHandler" });

/**
 * Centralized Express error handler. Maps typed AppErrors to their status/code;
 * everything else becomes an opaque 500. Never leaks internal messages unless
 * the error is explicitly marked `expose`.
 */
// Express identifies error handlers by their 4-arg signature; _next is required.
export function errorHandler(err, req, res, _next) {
  const status = err instanceof AppError ? err.status : err.status || 500;
  const code = err.code || "INTERNAL_ERROR";
  const expose = err.expose === true || status < 500;

  const logLevel = status >= 500 ? "error" : "warn";
  log[logLevel](
    { requestId: req.id, code, status, err: { message: scrubSecrets(err.message), stack: err.stack } },
    "request error",
  );

  res.status(status).json({
    error: {
      code,
      message: expose ? scrubSecrets(err.message) : "Internal server error",
      requestId: req.id,
    },
  });
}

export default errorHandler;
