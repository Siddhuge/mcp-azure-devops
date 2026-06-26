import { Router } from "express";
import {
  getLogs,
  getRawLogContent,
  classifyLogs,
  getRecentBuilds,
  getProjects,
} from "../controllers/logs.controller.js";
import { expensiveLimiter } from "../middleware/rateLimiter.js";

const router = Router();

// Order matters: more specific paths before the bare :buildId catch-all.
// All build routes accept an optional ?project= query (defaults to AZURE_PROJECT).
// classify can trigger the LLM tier — apply the stricter per-identity limit.
router.get("/:buildId/classify", expensiveLimiter, classifyLogs);
router.get("/:buildId/logs/:logId", getRawLogContent);
router.get("/:buildId", getLogs);

export const buildsRouter = Router();
buildsRouter.get("/", getRecentBuilds);

export const projectsRouter = Router();
projectsRouter.get("/", getProjects);

export default router;
