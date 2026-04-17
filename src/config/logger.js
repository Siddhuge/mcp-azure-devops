const pino = require("pino");

const isDev = process.env.NODE_ENV !== "production";

const logger = pino(
  isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true
          }
        }
      }
    : {}
);

module.exports = logger;