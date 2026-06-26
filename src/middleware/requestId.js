import { randomUUID } from "node:crypto";

/** Attach a unique request id, echoed back via the X-Request-Id header. */
export function requestId(req, res, next) {
  req.id = req.headers["x-request-id"] || randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
}

export default requestId;
