function createRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`.toUpperCase();
}

module.exports = function requestIdMiddleware(req, res, next) {
  const incoming = req.headers["x-request-id"];
  req.requestId = String(incoming || createRequestId());
  res.setHeader("x-request-id", req.requestId);
  next();
};
