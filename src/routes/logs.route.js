const router = require("express").Router();
const controller = require("../controllers/logs.controller");

// 🔥 NEW STRUCTURE
router.get("/:buildId/classify", controller.classifyLogs);
router.get("/:buildId", controller.getLogs);

module.exports = router;