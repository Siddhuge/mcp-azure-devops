const { randomUUID } = require("crypto");

module.exports = (req, res, next) => {
  req.id = randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
};