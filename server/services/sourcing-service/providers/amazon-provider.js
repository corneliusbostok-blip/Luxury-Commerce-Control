const { BaseProvider } = require("./base-provider");

class AmazonProvider extends BaseProvider {
  providerName() {
    return "amazon";
  }

  async search() {
    return [];
  }
}

module.exports = { AmazonProvider };
