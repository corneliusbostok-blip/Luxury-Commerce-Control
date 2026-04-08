class BaseProvider {
  providerName() {
    return "base";
  }

  async search() {
    throw new Error("Provider search() not implemented");
  }

  async getDetails() {
    return null;
  }

  normalize(raw) {
    return raw;
  }
}

module.exports = { BaseProvider };
