function success(res, data, message = "OK", status = 200) {
  return res.status(status).json({
    success: true,
    ok: true,
    data: data == null ? null : data,
    error: null,
    message,
  });
}

function failure(res, status, code, message, details) {
  return res.status(status).json({
    success: false,
    ok: false,
    data: null,
    error: {
      code: code || "INTERNAL_ERROR",
      details: details || null,
    },
    message: message || "Request failed",
  });
}

module.exports = {
  success,
  failure,
};
