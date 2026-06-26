import rateLimit from "express-rate-limit";
import { config } from "../config/env.js";
import { getRedisClient } from "../store/index.js";
import { RedisRateStore } from "./redisRateStore.js";

const message = (m) => ({ error: { code: "RATE_LIMITED", message: m } });
const { windowMs, globalMax, identityMax, expensiveMax } = config.rateLimit;

// When Redis is configured, share counters across replicas so the limits are
// GLOBAL (not per-process). Otherwise express-rate-limit's default in-memory
// store is used (correct for a single instance).
const redis = getRedisClient();

/** Build limiter options, adding a Redis-backed store only when available. */
function limiter(prefix, opts) {
  const base = { windowMs, standardHeaders: true, legacyHeaders: false, ...opts };
  if (redis) base.store = new RedisRateStore(redis, prefix);
  return rateLimit(base);
}

/** Key by authenticated identity when present, else client IP. */
const byIdentity = (req) => (req.auth && req.auth.id) || req.ip;

/** Coarse per-IP guard on the whole surface (applied before auth). */
export const rateLimiter = limiter("rl:global:", {
  max: globalMax,
  message: message("Too many requests"),
});

/** Per-identity limit for normal authenticated API calls. */
export const identityLimiter = limiter("rl:identity:", {
  max: identityMax,
  keyGenerator: byIdentity,
  message: message("Too many requests for this identity"),
});

/** Stricter per-identity limit for expensive LLM paths (chat, classify). */
export const expensiveLimiter = limiter("rl:expensive:", {
  max: expensiveMax,
  keyGenerator: byIdentity,
  message: message("Too many analysis requests — slow down"),
});

export default rateLimiter;
