import rateLimit from "express-rate-limit";

/** Per-IP rate limit for the REST/MCP-HTTP surface. */
export const rateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many requests" } },
});

export default rateLimiter;
