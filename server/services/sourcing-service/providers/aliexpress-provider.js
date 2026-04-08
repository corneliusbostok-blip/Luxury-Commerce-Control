const { BaseProvider } = require("./base-provider");

class AliExpressProvider extends BaseProvider {
  providerName() {
    return "aliexpress";
  }

  async search() {
    return [];
  }
}

module.exports = { AliExpressProvider };
