class BaseMarketingProvider {
  platform() {
    throw new Error("platform() must be implemented");
  }

  isConnected(marketingConfig) {
    const p = (marketingConfig && marketingConfig.platforms && marketingConfig.platforms[this.platform()]) || {};
    return Boolean(String(p.token || "").trim());
  }

  isEnabled(marketingConfig) {
    const p = (marketingConfig && marketingConfig.platforms && marketingConfig.platforms[this.platform()]) || {};
    return p.enabled !== false;
  }

  async dryRunPost(_post, _context = {}) {
    return { ok: true, id: `dry_${this.platform()}_${Date.now()}`, status: "preview" };
  }

  async publishPost(post, context = {}) {
    return this.dryRunPost(post, context);
  }
}

module.exports = { BaseMarketingProvider };
