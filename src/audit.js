import { logger } from "./config/logger.js";
import { scrubSecrets } from "./config/redact.js";

const auditLogger = logger.child({ audit: true });

/**
 * Emit a structured audit event (one JSON line, SIEM-shippable on stdout/stderr).
 * Records who did what, against which target, and the outcome — the durable
 * trail enterprises require for access to build data.
 *
 * @param {import("express").Request} req  carries req.auth (actor) and req.id
 * @param {{ action: string, target?: object, source?: string, costUsd?: number, outcome?: string }} event
 */
export function audit(req, event) {
  const actor = req.auth || { type: "anonymous", id: "anonymous" };
  auditLogger.info(
    {
      event: "audit",
      ts: new Date().toISOString(),
      requestId: req.id,
      actor: { type: actor.type, id: scrubSecrets(actor.id) },
      action: event.action,
      target: event.target,
      source: event.source,
      costUsd: event.costUsd,
      outcome: event.outcome || "ok",
    },
    `audit ${event.action}`,
  );
}
