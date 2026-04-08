class FixedWindowRateLimiter {
  constructor({ maxRequests, windowMs }) {
    this.maxRequests = Math.max(1, Number(maxRequests) || 5);
    this.windowMs = Math.max(250, Number(windowMs) || 1000);
    this.timestamps = [];
  }

  async take() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((x) => now - x < this.windowMs);
    if (this.timestamps.length < this.maxRequests) {
      this.timestamps.push(now);
      return;
    }
    const waitMs = this.windowMs - (now - this.timestamps[0]);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs)));
    return this.take();
  }
}

module.exports = { FixedWindowRateLimiter };
