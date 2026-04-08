const logger = require("../lib/logger");

function requestId() {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  ).toUpperCase();
}

module.exports = function requestContext(req, res, next) {
  const id = req.requestId || req.headers["x-request-id"] || requestId();
  req.requestId = String(id);
  res.setHeader("x-request-id", req.requestId);
  const start = Date.now();

  logger.info("request.start", {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl || req.url,
  });

  res.on("finish", () => {
    logger.info("request.finish", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });

  next();
};
