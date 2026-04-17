const asyncHandler = require("../utils/asyncHandler");

// 🔹 Services
const { getLogs, getLogContent } = require("../services/azure.service");
const { classify } = require("../services/classifier.service");

// 🔹 Utils
const { parseLogs } = require("../utils/logParser");

// ==========================
// GET BUILD LOGS (metadata)
// ==========================
exports.getLogs = asyncHandler(async (req, res) => {
  const { buildId } = req.params;

  if (!buildId) {
    const err = new Error("buildId required");
    err.status = 400;
    throw err;
  }

  const data = await getLogs(buildId);
  res.json(data);
});

// ==========================
// GET RAW LOG CONTENT
// ==========================
exports.getLogContent = asyncHandler(async (req, res) => {
  const { buildId, logId } = req.params;

  const data = await getLogContent(buildId, logId);

  res.send(data); // raw logs
});

// ==========================
// PARSED LOGS (errors/warnings)
// ==========================
exports.getParsedLogs = asyncHandler(async (req, res) => {
  const { buildId, logId } = req.params;

  const rawLogs = await getLogContent(buildId, logId);
  const parsed = parseLogs(rawLogs.value || rawLogs);

  res.json(parsed);
});

// ==========================
// CLASSIFY FAILURE (FINAL)
// ==========================
exports.classifyLogs = asyncHandler(async (req, res) => {
  const { buildId } = req.params;

  const logsMeta = await getLogs(buildId);

  let allLines = [];

  const logResults = await Promise.all(
    logsMeta.value.map(log => getLogContent(buildId, log.id))
  );

  // 🔥 FIXED LOOP
  for (const content of logResults) {
    if (Array.isArray(content)) {
      allLines.push(...content);
    }
  }

  const filteredLines = allLines.filter(line => {
    const l = line.toLowerCase();
    return (
      l.includes("error") ||
      l.includes("failed") ||
      l.includes("exception") ||
      l.includes("warning") ||
      l.includes("toomanyrequests")
    );
  });

  const parsed = parseLogs(filteredLines);
  const result = await classify(parsed);

  res.json({
    ...result,
    totalLines: allLines.length,
    filteredLines: filteredLines.length
  });
});