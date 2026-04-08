const { EbayProvider } = require("./ebay-provider");
const { AmazonProvider } = require("./amazon-provider");
const { AliExpressProvider } = require("./aliexpress-provider");

function defaultProviders() {
  return [new EbayProvider(), new AmazonProvider(), new AliExpressProvider()];
}

async function discoverFromProviders(input) {
  const providers = input.providers || defaultProviders();
  const query = String(input.query || "").trim();
  const limit = Math.max(1, Number(input.limit) || 30);
  const storeConfig = input.storeConfig || null;
  const chunks = await Promise.all(
    providers.map((p) =>
      p.search({ query, limit, storeConfig }).catch(() => [])
    )
  );
  return chunks.flat();
}

module.exports = { defaultProviders, discoverFromProviders };
