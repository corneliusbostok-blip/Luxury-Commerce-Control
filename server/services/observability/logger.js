function safeSerialize(value) {
  if (value == null) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }
  return value;
}

function write(level, event, context) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    context: safeSerialize(context || {}),
  };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function fromRequest(req, extra = {}) {
  return {
    requestId: req && req.requestId ? req.requestId : null,
    method: req && req.method ? req.method : null,
    path: req && (req.originalUrl || req.url) ? req.originalUrl || req.url : null,
    userEmail:
      (req && req.body && req.body.customer && req.body.customer.email) ||
      (req && req.body && req.body.email) ||
      null,
    ...extra,
  };
}

module.exports = {
  info(event, context) {
    write("info", event, context);
  },
  warn(event, context) {
    write("warn", event, context);
  },
  error(event, context) {
    write("error", event, context);
  },
  fromRequest,
};
