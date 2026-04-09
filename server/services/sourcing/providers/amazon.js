const { normalizeDiscoveredPriceToDkk } = require("../../currency");
const { inferCategory, inferProductColor } = require("../../category");
const { FixedWindowRateLimiter } = require("./rate-limiter");
const { normalizeImages, normalizeVariants } = require("../../product-sync-normalizer");
const { chooseBestProductImage, improveImageUrlQuality } = require("../../image-quality");

const limiter = new FixedWindowRateLimiter({
  maxRequests: Number(process.env.AMAZON_API_RATE_LIMIT_PER_SEC) || 3,
  windowMs: 1000,
});

function providerListAllowsAmazon(storeConfig) {
  const es = storeConfig && storeConfig.enabledSources;
  if (!Array.isArray(es) || !es.length) return true;
  return es.some((t) => String(t || "").toLowerCase().includes("amazon"));
}

function isAmazonSourcingActive(storeConfig) {
  if (!storeConfig || !providerListAllowsAmazon(storeConfig)) return false;
  const p = storeConfig.sourcing?.providers?.amazon;
  if (!p || p.enabled !== true) return false;
  const key = String(p.rapidApiKey || process.env.AMAZON_RAPIDAPI_KEY || "").trim();
  return Boolean(key);
}

async function fetchAmazonProductCandidates(limit, options = {}) {
  if (limit <= 0) return [];
  const storeConfig = options.storeConfig || null;
  if (!isAmazonSourcingActive(storeConfig)) return [];
  const p = storeConfig.sourcing.providers.amazon || {};
  const apiKey = String(p.rapidApiKey || process.env.AMAZON_RAPIDAPI_KEY || "").trim();
  const host = String(p.rapidApiHost || "real-time-amazon-data.p.rapidapi.com").trim();
  const region = String(p.region || "US").trim().toUpperCase();
  const query = encodeURIComponent(String(options.chatSearchHint || "premium fashion men").trim());
  const sourceQuery = decodeURIComponent(query);

  await limiter.take();
  const res = await fetch(`https://${host}/search?query=${query}&country=${region}&page=1`, {
    headers: { "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": host },
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const body = await res.json().catch(() => null);
  const items = (body && body.data && (body.data.products || body.data.items)) || [];
  const out = [];
  for (const it of items) {
    const title = String(it.product_title || it.title || "").trim();
    const priceRaw = Number(it.product_price_value || it.price || 0);
    const image = String(it.product_photo || it.image || "").trim();
    const url = String(it.product_url || it.url || "").trim();
    if (!title || !priceRaw || !url) continue;
    const price = normalizeDiscoveredPriceToDkk(priceRaw, String(it.currency || "USD"), url);
    const selected = chooseBestProductImage([image, it.image_url, it.thumbnail]);
    if (!selected.image) {
      console.log("[discovery:image] reject", {
        provider: "amazon",
        reason: "no_valid_image",
        title: title.slice(0, 140),
        sourceUrl: url,
        rejected: selected.rejected.slice(0, 6),
      });
      continue;
    }
    const images = normalizeImages([selected.image, ...selected.accepted.map((x) => x.url)], selected.image);
    const variants = normalizeVariants(
      [{ size: null, color: inferProductColor(title), price, available: true }],
      { size: "unknown", color: inferProductColor(title), price, available: true }
    );
    out.push({
      title,
      price,
      image: improveImageUrlQuality(images[0] || selected.image),
      externalId: `amazon:${String(it.asin || it.product_id || url).slice(0, 180)}`,
      category: inferCategory(title),
      color: inferProductColor(title),
      sourcePlatform: "Amazon",
      sourceName: "Amazon Marketplace",
      sourceUrl: url,
      sourceProductId: String(it.asin || it.product_id || "").slice(0, 200),
      supplierName: "Amazon Marketplace",
      supplierCountry: region,
      importMethod: "amazon_rapidapi",
      sourceQuery,
      discovery_selection_mode: "exploit",
      discovery_query_confidence: "high",
      images,
      variants,
      available: variants.some((v) => v.available !== false),
    });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { isAmazonSourcingActive, fetchAmazonProductCandidates, providerListAllowsAmazon };
