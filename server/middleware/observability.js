const logger = require("../services/observability/logger");
const metrics = require("../services/observability/metrics");

module.exports = function observabilityMiddleware(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - start;
    const status = res.statusCode;
    if (status >= 400 && status < 500) {
      metrics.increment("api.4xx");
      logger.warn("api.response.4xx", logger.fromRequest(req, { status, durationMs }));
    } else if (status >= 500) {
      metrics.increment("api.5xx");
      logger.error("api.response.5xx", logger.fromRequest(req, { status, durationMs }));
    }
  });
  next();
};
