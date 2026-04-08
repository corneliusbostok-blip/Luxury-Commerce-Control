const { normalizeDiscoveredPriceToDkk } = require("../../currency");
const { inferCategory, inferProductColor } = require("../../category");
const { FixedWindowRateLimiter } = require("./rate-limiter");
const { normalizeImages, normalizeVariants } = require("../../product-sync-normalizer");

const limiter = new FixedWindowRateLimiter({
  maxRequests: Number(process.env.ALIEXPRESS_API_RATE_LIMIT_PER_SEC) || 3,
  windowMs: 1000,
});

function providerListAllowsAliExpress(storeConfig) {
  const es = storeConfig && storeConfig.enabledSources;
  if (!Array.isArray(es) || !es.length) return true;
  return es.some((t) => {
    const s = String(t || "").toLowerCase();
    return s.includes("aliexpress") || s.includes("ali");
  });
}

function isAliExpressSourcingActive(storeConfig) {
  if (!storeConfig || !providerListAllowsAliExpress(storeConfig)) return false;
  const p = storeConfig.sourcing?.providers?.aliexpress;
  if (!p || p.enabled !== true) return false;
  const key = String(p.rapidApiKey || process.env.ALIEXPRESS_RAPIDAPI_KEY || "").trim();
  return Boolean(key);
}

async function fetchAliExpressProductCandidates(limit, options = {}) {
  if (limit <= 0) return [];
  const storeConfig = options.storeConfig || null;
  if (!isAliExpressSourcingActive(storeConfig)) return [];
  const p = storeConfig.sourcing.providers.aliexpress || {};
  const apiKey = String(p.rapidApiKey || process.env.ALIEXPRESS_RAPIDAPI_KEY || "").trim();
  const host = String(p.rapidApiHost || "aliexpress-datahub.p.rapidapi.com").trim();
  const query = encodeURIComponent(String(options.chatSearchHint || "premium men fashion").trim());
  const sourceQuery = decodeURIComponent(query);

  await limiter.take();
  const res = await fetch(`https://${host}/item_search?q=${query}&page=1`, {
    headers: { "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": host },
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const body = await res.json().catch(() => null);
  const items = (body && (body.result?.resultList || body.data?.items || body.items)) || [];
  const out = [];
  for (const it of items) {
    const title = String(it.title?.displayTitle || it.title || "").trim();
    const image = String(it.image || it.productImage || it.imageUrl || "").trim();
    const url = String(it.itemUrl || it.productUrl || "").trim();
    const pRaw = Number(it.sku?.def?.promotionPrice || it.price || 0);
    if (!title || !image || !url || !pRaw) continue;
    const price = normalizeDiscoveredPriceToDkk(pRaw, "USD", url);
    const images = normalizeImages([image, it.imageUrl, it.productImage], image);
    const variants = normalizeVariants(
      [{ size: null, color: inferProductColor(title), price, available: true }],
      { size: "unknown", color: inferProductColor(title), price, available: true }
    );
    out.push({
      title,
      price,
      image: images[0] || image,
      externalId: `aliexpress:${String(it.itemId || it.productId || url).slice(0, 180)}`,
      category: inferCategory(title),
      color: inferProductColor(title),
      sourcePlatform: "AliExpress",
      sourceName: "AliExpress Marketplace",
      sourceUrl: url,
      sourceProductId: String(it.itemId || it.productId || "").slice(0, 200),
      supplierName: "AliExpress Marketplace",
      supplierCountry: "CN",
      importMethod: "aliexpress_rapidapi",
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

module.exports = {
  isAliExpressSourcingActive,
  fetchAliExpressProductCandidates,
  providerListAllowsAliExpress,
};
