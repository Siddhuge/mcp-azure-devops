import { asyncHandler } from "../utils/asyncHandler.js";
import { analyzeBuild } from "../analyzer/index.js";
import {
  getBuildLogs,
  getLogContent,
  listRecentBuilds,
  listProjects,
} from "../services/azure.service.js";
import {
  buildIdSchema,
  logContentSchema,
  listBuildsSchema,
  projectQuerySchema,
  parseOrThrow,
} from "../schemas/logs.schema.js";

/** GET /logs/:buildId?project= — log file metadata for a build. */
export const getLogs = asyncHandler(async (req, res) => {
  const { buildId } = parseOrThrow(buildIdSchema, req.params);
  const { project } = parseOrThrow(projectQuerySchema, req.query);
  res.json(await getBuildLogs(buildId, project));
});

/** GET /logs/:buildId/logs/:logId?project= — raw content of a single log file. */
export const getRawLogContent = asyncHandler(async (req, res) => {
  const { buildId, logId } = parseOrThrow(logContentSchema, req.params);
  const { project } = parseOrThrow(projectQuerySchema, req.query);
  const lines = await getLogContent(buildId, logId, project);
  res.type("text/plain").send(lines.join("\n"));
});

/** GET /logs/:buildId/classify?project= — tiered failure analysis. */
export const classifyLogs = asyncHandler(async (req, res) => {
  const { buildId } = parseOrThrow(buildIdSchema, req.params);
  const { project } = parseOrThrow(projectQuerySchema, req.query);
  res.json(await analyzeBuild(buildId, project));
});

/** GET /builds?project=&top=&resultFilter= — recent builds in a project. */
export const getRecentBuilds = asyncHandler(async (req, res) => {
  const { top, resultFilter, project } = parseOrThrow(listBuildsSchema, req.query);
  res.json(await listRecentBuilds({ top, resultFilter, project }));
});

/** GET /projects — all projects in the organization. */
export const getProjects = asyncHandler(async (_req, res) => {
  res.json(await listProjects());
});
