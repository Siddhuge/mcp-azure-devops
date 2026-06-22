import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { UnauthorizedError } from "../utils/errors.js";
import { verifyJwt, looksLikeJwt } from "../auth/oidc.js";

const log = logger.child({ module: "auth" });

/**
 * Parse API_TOKENS entries ("name:secret" or bare "secret") into a name → SHA-256
 * map. Secrets are hashed at rest; the raw value never lives in memory after boot.
 * @type {Map<string, string>}  name -> sha256(secret)
 */
const serviceTokens = new Map();
for (const entry of config.auth.tokens) {
  const idx = entry.indexOf(":");
  const name = idx > 0 ? entry.slice(0, idx) : "default";
  const secret = idx > 0 ? entry.slice(idx + 1) : entry;
  if (secret) serviceTokens.set(name, sha256(secret));
}

const oidcEnabled = config.auth.oidc.enabled;
export const authConfigured = serviceTokens.size > 0 || oidcEnabled;

if (!authConfigured) {
  log.warn("no API_TOKENS and no OIDC_ISSUER — auth is DISABLED (dev only)");
}

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

/** Constant-time compare of two equal-length hex digests. */
function hashEquals(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * @param {string|undefined} header
 * @returns {string|null}
 */
export function extractBearer(header) {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Match a presented secret against the named service tokens (constant-time).
 * @param {string} presented
 * @returns {{ type:"service", id:string } | null}
 */
function verifyServiceToken(presented) {
  const hash = sha256(presented);
  for (const [name, stored] of serviceTokens) {
    if (hashEquals(hash, stored)) return { type: "service", id: name };
  }
  return null;
}

/**
 * Express auth middleware. Accepts a named service token OR (when OIDC is
 * configured) an OIDC/JWT bearer. Attaches `req.auth = { type, id, ... }`.
 * When nothing is configured, auth is a no-op (dev only).
 */
export async function requireAuth(req, _res, next) {
  if (!authConfigured) {
    req.auth = { type: "anonymous", id: "anonymous" };
    return next();
  }

  const token = extractBearer(req.headers.authorization);
  if (!token) return next(new UnauthorizedError());

  try {
    // OIDC JWTs are 3-segment; everything else is treated as a service token.
    if (oidcEnabled && looksLikeJwt(token)) {
      req.auth = await verifyJwt(token);
      return next();
    }
    const svc = verifyServiceToken(token);
    if (svc) {
      req.auth = svc;
      return next();
    }
    return next(new UnauthorizedError());
  } catch (err) {
    return next(err);
  }
}

export default requireAuth;
