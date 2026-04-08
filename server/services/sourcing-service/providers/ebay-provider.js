const { BaseProvider } = require("./base-provider");
const { fetchEbayProductCandidates } = require("../../sourcing/providers");

class EbayProvider extends BaseProvider {
  providerName() {
    return "ebay";
  }

  async search({ query, limit, storeConfig }) {
    const rows = await fetchEbayProductCandidates(Math.max(1, limit || 20), {
      storeConfig,
      queryOverride: query || "",
    });
    return Array.isArray(rows) ? rows : [];
  }
}

module.exports = { EbayProvider };
