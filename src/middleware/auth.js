import { timingSafeEqual } from "node:crypto";
import { config } from "../config/env.js";
import { UnauthorizedError } from "../utils/errors.js";

/**
 * Constant-time check of a presented token against the configured allowlist.
 * @param {string} presented
 * @returns {boolean}
 */
function tokenAllowed(presented) {
  const a = Buffer.from(presented);
  return config.apiTokens.some((token) => {
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/**
 * Extract a bearer token from an Authorization header value.
 * @param {string|undefined} header
 * @returns {string|null}
 */
export function extractBearer(header) {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Express bearer-auth middleware. When no API_TOKENS are configured, auth is a
 * no-op (intended for local development only) and a warning is logged at boot.
 */
export function requireAuth(req, _res, next) {
  if (config.apiTokens.length === 0) return next();

  const token = extractBearer(req.headers.authorization);
  if (!token || !tokenAllowed(token)) {
    return next(new UnauthorizedError());
  }
  return next();
}

export default requireAuth;
