const { failure } = require("../lib/api-response");
const logger = require("../lib/logger");

module.exports = function errorHandler(err, req, res, _next) {
  const status = Number(err && err.status) || 500;
  const code = (err && err.code) || "INTERNAL_ERROR";
  const message =
    (err && err.expose !== false && err.message) || "Internal server error";
  const details = (err && err.details) || null;

  logger.error("request.error", {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl || req.url,
    status,
    code,
    message: err && err.message,
    stack: err && err.stack,
  });

  if (res.headersSent) return;
  failure(res, status, code, message, details);
};
