const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const pinoHttp = require("pino-http");

const logger = require("./config/logger");
const requestId = require("./middleware/requestId");
const errorHandler = require("./middleware/errorHandler");
const rateLimiter = require("./middleware/rateLimiter");

const logsRoute = require("./routes/logs.route");

const app = express();

app.use(helmet());
app.use(cors({ origin: ["http://localhost:3000"] }));
app.use(express.json());

app.use(requestId);
app.use(pinoHttp({ logger }));

app.use(rateLimiter);

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.use("/logs", logsRoute);

app.get("/", (req, res) => {
  res.send("MCP Azure DevOps Server Running");
});

app.use(errorHandler);

module.exports = app;