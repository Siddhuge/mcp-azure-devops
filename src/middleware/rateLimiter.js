import rateLimit from "express-rate-limit";
import { config } from "../config/env.js";

const message = (m) => ({ error: { code: "RATE_LIMITED", message: m } });
const { windowMs, globalMax, identityMax, expensiveMax } = config.rateLimit;

/** Key by authenticated identity when present, else client IP. */
const byIdentity = (req) => (req.auth && req.auth.id) || req.ip;

/** Coarse per-IP guard on the whole surface (applied before auth). */
export const rateLimiter = rateLimit({
  windowMs,
  max: globalMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: message("Too many requests"),
});

/** Per-identity limit for normal authenticated API calls. */
export const identityLimiter = rateLimit({
  windowMs,
  max: identityMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byIdentity,
  message: message("Too many requests for this identity"),
});

/** Stricter per-identity limit for expensive LLM paths (chat, classify). */
export const expensiveLimiter = rateLimit({
  windowMs,
  max: expensiveMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byIdentity,
  message: message("Too many analysis requests — slow down"),
});

export default rateLimiter;
