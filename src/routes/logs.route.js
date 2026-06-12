import { Router } from "express";
import {
  getLogs,
  getRawLogContent,
  classifyLogs,
  getRecentBuilds,
  getProjects,
} from "../controllers/logs.controller.js";

const router = Router();

// Order matters: more specific paths before the bare :buildId catch-all.
// All build routes accept an optional ?project= query (defaults to AZURE_PROJECT).
router.get("/:buildId/classify", classifyLogs);
router.get("/:buildId/logs/:logId", getRawLogContent);
router.get("/:buildId", getLogs);

export const buildsRouter = Router();
buildsRouter.get("/", getRecentBuilds);

export const projectsRouter = Router();
projectsRouter.get("/", getProjects);

export default router;
