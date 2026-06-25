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

/**
 * Collect a scope/role claim that may be either a space-delimited string or an
 * array, into `out`. Entra v2 delivers delegated scopes in `scp` as a STRING
 * (e.g. "access_as_user"); OAuth uses `scope` (string); app roles use `roles`
 * (array). Handle all shapes so enforcement works across IdPs.
 */
function addClaim(out, val) {
  if (typeof val === "string") val.split(/\s+/).forEach((s) => s && out.add(s));
  else if (Array.isArray(val)) val.forEach((s) => typeof s === "string" && s && out.add(s));
}

/** Parse `scope` / `scp` / `roles` (string or array) into a set of granted scopes. */
function extractScopes(payload) {
  const out = new Set();
  addClaim(out, payload.scope);
  addClaim(out, payload.scp);
  addClaim(out, payload.roles);
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
