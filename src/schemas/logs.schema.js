import { z } from "zod";
import { ValidationError } from "../utils/errors.js";

/**
 * Shared validation schemas used by both the REST routes and the MCP tools so
 * the two surfaces stay in lockstep. Build/log IDs are coerced to strings and
 * constrained to digits, which is what the Azure REST API expects.
 */

const idLike = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(z.string().regex(/^\d+$/, "must be a numeric id"));

// Azure project name or GUID; permissive but bounded.
export const projectName = z.string().trim().min(1).max(200);

export const buildIdSchema = z.object({
  buildId: idLike,
});

export const logContentSchema = z.object({
  buildId: idLike,
  logId: idLike,
});

/** Optional `project` query param shared by the build routes. */
export const projectQuerySchema = z.object({
  project: projectName.optional(),
});

export const listBuildsSchema = z.object({
  top: z.coerce.number().int().min(1).max(100).default(20),
  resultFilter: z
    .enum(["succeeded", "failed", "canceled", "partiallySucceeded"])
    .optional(),
  project: projectName.optional(),
});

/**
 * Validate `data` against a Zod schema, throwing a ValidationError on failure.
 * @template T
 * @param {import("zod").ZodSchema<T>} schema
 * @param {unknown} data
 * @returns {T}
 */
export function parseOrThrow(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => `${i.path.join(".") || "value"}: ${i.message}`)
      .join("; ");
    throw new ValidationError(message);
  }
  return result.data;
}
