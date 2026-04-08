const obsLogger = require("./logger");

function logDeadLetter(event, context) {
  obsLogger.error(`dead_letter.${event}`, {
    ...(context || {}),
    permanentFailure: true,
  });
}

module.exports = { logDeadLetter };
