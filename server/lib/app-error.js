class AppError extends Error {
  constructor(message, options = {}) {
    super(message || "Application error");
    this.name = "AppError";
    this.status = Number(options.status) || 500;
    this.code = options.code || "INTERNAL_ERROR";
    this.details = options.details || null;
    this.expose = options.expose !== false;
  }
}

module.exports = {
  AppError,
};
