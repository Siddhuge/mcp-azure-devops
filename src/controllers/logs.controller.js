import { asyncHandler } from "../utils/asyncHandler.js";
import { analyzeBuild } from "../analyzer/index.js";
import { getBuildLogs, getLogContent, listRecentBuilds, listProjects } from "../services/azure.service.js";
import {
  buildIdSchema,
  logContentSchema,
  listBuildsSchema,
  projectQuerySchema,
  parseOrThrow,
} from "../schemas/logs.schema.js";
import { audit } from "../audit.js";

/** GET /logs/:buildId?project= — log file metadata for a build. */
export const getLogs = asyncHandler(async (req, res) => {
  const { buildId } = parseOrThrow(buildIdSchema, req.params);
  const { project } = parseOrThrow(projectQuerySchema, req.query);
  const data = await getBuildLogs(buildId, project);
  audit(req, { action: "get_build_logs", target: { buildId, project } });
  res.json(data);
});

/** GET /logs/:buildId/logs/:logId?project= — raw content of a single log file. */
export const getRawLogContent = asyncHandler(async (req, res) => {
  const { buildId, logId } = parseOrThrow(logContentSchema, req.params);
  const { project } = parseOrThrow(projectQuerySchema, req.query);
  const lines = await getLogContent(buildId, logId, project);
  audit(req, { action: "get_log_content", target: { buildId, logId, project } });
  res.type("text/plain").send(lines.join("\n"));
});

/** GET /logs/:buildId/classify?project= — tiered failure analysis. */
export const classifyLogs = asyncHandler(async (req, res) => {
  const { buildId } = parseOrThrow(buildIdSchema, req.params);
  const { project } = parseOrThrow(projectQuerySchema, req.query);
  const result = await analyzeBuild(buildId, project);
  audit(req, {
    action: "analyze_pipeline_failure",
    target: { buildId, project },
    source: result.source,
    costUsd: result.meta?.costUsd,
  });
  res.json(result);
});

/** GET /builds?project=&top=&resultFilter= — recent builds in a project. */
export const getRecentBuilds = asyncHandler(async (req, res) => {
  const { top, resultFilter, project } = parseOrThrow(listBuildsSchema, req.query);
  const data = await listRecentBuilds({ top, resultFilter, project });
  audit(req, { action: "list_recent_builds", target: { project, top, resultFilter } });
  res.json(data);
});

/** GET /projects — all projects in the organization. */
export const getProjects = asyncHandler(async (req, res) => {
  const data = await listProjects();
  audit(req, { action: "list_projects" });
  res.json(data);
});
