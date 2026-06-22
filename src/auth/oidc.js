import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { UnauthorizedError, ForbiddenError } from "../utils/errors.js";

const log = logger.child({ module: "auth.oidc" });

/**
 * JWKS resolver. Lazily created from OIDC_JWKS_URL, or `${issuer}/.well-known/jwks.json`.
 * Overridable for hermetic tests via __setKeyResolver.
 * @type {import("jose").JWTVerifyGetKey | undefined}
 */
let _jwks;
function getJwks() {
  if (_jwks) return _jwks;
  const url = config.auth.oidc.jwksUrl || new URL(".well-known/jwks.json", ensureSlash(config.auth.oidc.issuer)).href;
  _jwks = createRemoteJWKSet(new URL(url));
  return _jwks;
}

function ensureSlash(s) {
  return s.endsWith("/") ? s : `${s}/`;
}

/** Test seam: inject a key resolver (e.g. a local JWKS) instead of fetching one. */
export function __setKeyResolver(resolver) {
  _jwks = resolver;
}

/** Parse the `scope` (space-delimited) and/or `scp`/`roles` claims into a set. */
function extractScopes(payload) {
  const out = new Set();
  if (typeof payload.scope === "string") payload.scope.split(/\s+/).forEach((s) => s && out.add(s));
  if (Array.isArray(payload.scp)) payload.scp.forEach((s) => out.add(s));
  if (Array.isArray(payload.roles)) payload.roles.forEach((s) => out.add(s));
  return out;
}

/**
 * Verify an OIDC JWT and return the caller identity.
 * @param {string} token
 * @returns {Promise<{ type: "user", id: string, sub: string, email?: string, scopes: string[] }>}
 */
export async function verifyJwt(token) {
  const { oidc } = config.auth;
  let payload;
  try {
    ({ payload } = await jwtVerify(token, getJwks(), {
      issuer: oidc.issuer,
      audience: oidc.audience || undefined,
    }));
  } catch (err) {
    log.warn({ reason: err.code || err.message }, "jwt verification failed");
    throw new UnauthorizedError("Invalid or expired token");
  }

  const scopes = extractScopes(payload);
  if (oidc.requiredScope && !scopes.has(oidc.requiredScope)) {
    throw new ForbiddenError(`Token missing required scope '${oidc.requiredScope}'`);
  }
  return {
    type: "user",
    id: payload.email || payload.preferred_username || payload.sub,
    sub: payload.sub,
    email: payload.email,
    scopes: [...scopes],
  };
}

/** A JWT is a dot-delimited 3-segment string; used to route bearer tokens to JWT vs service-token. */
export function looksLikeJwt(token) {
  return typeof token === "string" && token.split(".").length === 3;
}
