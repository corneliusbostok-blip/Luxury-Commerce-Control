const logger = require("./logger");
const metrics = require("./metrics");

function runAlertChecks() {
  const failedCheckout1m = metrics.countInLastMs("checkout.failed", 60 * 1000);
  const dbRetryFailed1m = metrics.countInLastMs("db.retry.failed", 60 * 1000);

  if (failedCheckout1m > 5) {
    logger.error("ALERT.checkout.failed.spike", { failedCheckout1m });
  }
  if (dbRetryFailed1m > 3) {
    logger.error("ALERT.db.retry.failed.spike", { dbRetryFailed1m });
  }
}

function startAlertEngine() {
  runAlertChecks();
  return setInterval(runAlertChecks, 30 * 1000);
}

module.exports = {
  startAlertEngine,
  runAlertChecks,
};
