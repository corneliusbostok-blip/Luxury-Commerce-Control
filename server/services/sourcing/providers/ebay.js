/**
 * eBay Browse API → samme rå kandidatform som web/Shopify discovery.
 */

const { normalizeDiscoveredPriceToDkk } = require("../../currency");
const { inferCategory, inferProductColor, normalizeCategoryId } = require("../../category");
const {
  getEbayAccessTokenFromIntegrations,
  ebayBrowseItemSummarySearch,
  ebayMarketplaceId,
} = require("../../ebay-api");
const { buildEbayQueries } = require("../query-engine");
const { normalizeImages, normalizeVariants } = require("../../product-sync-normalizer");
const { chooseBestProductImage, improveImageUrlQuality } = require("../../image-quality");

const AUTOMOTIVE_OFFTOPIC = [
  "car",
  "cars",
  "auto",
  "automotive",
  "vehicle",
  "vehicles",
  "truck",
  "engine",
  "bumper",
  "headlight",
  "taillight",
  "mirror",
  "maintenance",
  "detailing",
  "coating",
  "plastic",
  "repair",
  "motorcycle",
];

const CATEGORY_RELEVANCE_RULES = {
  outerwear: {
    mustHaveAny: ["jacket", "coat", "parka", "trench", "blazer", "outerwear", "jakke", "frakke"],
    blockAny: AUTOMOTIVE_OFFTOPIC,
  },
  shirts: {
    mustHaveAny: ["shirt", "skjorte", "button", "oxford", "poplin"],
    blockAny: AUTOMOTIVE_OFFTOPIC,
  },
  polos: {
    mustHaveAny: ["polo", "pique"],
    blockAny: AUTOMOTIVE_OFFTOPIC,
  },
  knitwear: {
    mustHaveAny: ["sweater", "knit", "cardigan", "pullover", "strik"],
    blockAny: AUTOMOTIVE_OFFTOPIC,
  },
  trousers: {
    mustHaveAny: ["trousers", "pants", "chino", "jeans", "bukser"],
    blockAny: AUTOMOTIVE_OFFTOPIC,
  },
  shoes: {
    mustHaveAny: ["shoe", "shoes", "loafer", "derby", "oxford", "boots", "sneaker", "sko"],
    blockAny: [...AUTOMOTIVE_OFFTOPIC, "brake", "tires", "tyre"],
  },
  footwear_boots: {
    mustHaveAny: ["boot", "boots", "chelsea", "ankle", "stovle", "stovler"],
    blockAny: [...AUTOMOTIVE_OFFTOPIC, "workwear", "safety"],
  },
  footwear_sneakers: {
    mustHaveAny: ["sneaker", "sneakers", "trainer", "trainers"],
    blockAny: AUTOMOTIVE_OFFTOPIC,
  },
};

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9æøå\s-]/g, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function includesAnyToken(tokens, words) {
  if (!Array.isArray(tokens) || !tokens.length) return false;
  const set = new Set(tokens);
  for (const w of words || []) {
    if (!w) continue;
    const n = String(w).toLowerCase();
    if (set.has(n)) return true;
  }
  return false;
}

function blockedByNegativeTitleTerms(title, negatives) {
  const tokens = tokenize(title);
  if (!tokens.length) return false;
  return includesAnyToken(tokens, negatives || []);
}

function categoryRelevanceRejectReason(title, categoryId, strict) {
  const cid = normalizeCategoryId(categoryId || "");
  const rule = CATEGORY_RELEVANCE_RULES[cid];
  if (!rule) return null;
  const tokens = tokenize(title);
  if (!tokens.length) return "empty_title";
  if (includesAnyToken(tokens, rule.blockAny || [])) return "offtopic_blocked_token";
  if (strict && !includesAnyToken(tokens, rule.mustHaveAny || [])) return "missing_category_tokens";
  return null;
}

function providerListAllowsEbay(storeConfig) {
  const es = storeConfig && storeConfig.enabledSources;
  if (!Array.isArray(es) || !es.length) return true;
  return es.some((t) => String(t || "").toLowerCase().includes("ebay"));
}

function ebayIntegrationConfigured(storeConfig) {
  const int = storeConfig && storeConfig.integrations && storeConfig.integrations.ebay;
  if (!int || typeof int !== "object") return false;
  const id = String(int.clientId || "").trim();
  const hasSecret = String(int.clientSecret || "").trim().length > 0;
  const hasTok = String(int.oauthToken || "").trim().length > 0;
  return Boolean(id && (hasSecret || hasTok));
}

/**
 * Kræver: eBay valgt som kilde, integration med nøgler, og «Aktivér Browse-import» i provider.
 */
function isEbaySourcingActive(storeConfig) {
  if (!storeConfig || !providerListAllowsEbay(storeConfig)) return false;
  const p = storeConfig.sourcing && storeConfig.sourcing.providers && storeConfig.sourcing.providers.ebay;
  if (!p || typeof p !== "object" || p.enabled !== true) return false;
  return ebayIntegrationConfigured(storeConfig);
}

const queryRotationState = new Map();

function queryRotationKey(storeConfig, options) {
  const cats = Array.isArray(storeConfig && storeConfig.allowedCategories)
    ? [...new Set(storeConfig.allowedCategories.map((c) => normalizeCategoryId(c)).filter(Boolean))]
    : [];
  return JSON.stringify({
    categories: cats,
    categoryIntent: options && options.categoryIntent ? normalizeCategoryId(options.categoryIntent) : null,
    chatMode: Boolean(options && options.chatMode),
  });
}

function pickEbayQueryVariant(storeConfig, options = {}) {
  const built = buildEbayQueries({
    storeConfig,
    categoryIntent: options.categoryIntent || null,
    chatSearchHint: options.chatSearchHint || "",
  });
  const queries = built.queries || [];
  if (!queries.length) {
    return { query: "collectibles", categoryId: "other", type: "fallback", debug: built.debug || {} };
  }
  const key = queryRotationKey(storeConfig, options);
  const idx = queryRotationState.get(key) || 0;
  const pick = queries[idx % queries.length];
  queryRotationState.set(key, (idx + 1) % Math.max(queries.length, 1));
  return {
    query: pick.query,
    categoryId: pick.categoryId,
    type: pick.type,
    negative: pick.negative || [],
    debug: built.debug || {},
  };
}

function pickEbayQueryVariants(storeConfig, options = {}, count = 3) {
  const built = buildEbayQueries({
    storeConfig,
    categoryIntent: options.categoryIntent || null,
    chatSearchHint: options.chatSearchHint || "",
  });
  const queries = built.queries || [];
  const fallback = [
    { query: "premium men fashion", categoryId: "other", type: "fallback_broad", negative: [] },
    { query: "mens clothing", categoryId: "other", type: "fallback_broad", negative: [] },
    { query: "men accessories", categoryId: "accessories", type: "fallback_broad", negative: [] },
  ];
  if (!queries.length) return fallback.slice(0, Math.max(1, count));

  const key = queryRotationKey(storeConfig, options);
  const start = queryRotationState.get(key) || 0;
  const chosen = [];
  for (let i = 0; i < Math.max(1, count); i++) {
    const pick = queries[(start + i) % queries.length];
    if (!pick) continue;
    chosen.push({
      query: pick.query,
      categoryId: pick.categoryId,
      type: pick.type,
      negative: pick.negative || [],
      selectionMode: pick.selectionMode || "exploit",
      confidence: pick.confidence || "low",
      debug: built.debug || {},
    });
  }
  queryRotationState.set(key, (start + Math.max(1, count)) % Math.max(queries.length, 1));
  return [...chosen, ...fallback].slice(0, Math.max(1, count + 1));
}

/**
 * @param {object} item — eBay itemSummary
 * @param {string} marketplaceId
 */
function ebayItemToDiscoveryCandidate(item, marketplaceId, sourceQuery = "", selectionMode = "unknown", queryConfidence = "low") {
  const itemId = String(item.itemId || "").trim();
  const title = String(item.title || "").trim();
  const webUrl = String(item.itemWebUrl || "").trim();
  let img = "";
  if (item.image && item.image.imageUrl) img = String(item.image.imageUrl);
  else if (item.thumbnailImages && item.thumbnailImages[0] && item.thumbnailImages[0].imageUrl) {
    img = String(item.thumbnailImages[0].imageUrl);
  }
  const selected = chooseBestProductImage([
    img,
    ...(Array.isArray(item.additionalImages) ? item.additionalImages.map((x) => x && x.imageUrl).filter(Boolean) : []),
    ...(Array.isArray(item.thumbnailImages) ? item.thumbnailImages.map((x) => x && x.imageUrl).filter(Boolean) : []),
  ]);
  const imageList = normalizeImages([selected.image, ...selected.accepted.map((x) => x.url)], selected.image);
  const priceObj = item.price || {};
  const rawVal = parseFloat(String(priceObj.value || "0")) || 0;
  const curr = String(priceObj.currency || "USD");
  const ctxUrl = webUrl || `https://www.ebay.com/itm/${encodeURIComponent(itemId)}`;
  const price = normalizeDiscoveredPriceToDkk(rawVal, curr, ctxUrl);
  const seller =
    item.seller && item.seller.username ? String(item.seller.username).trim() : "eBay";
  const safeExt = itemId.replace(/\|/g, ":");
  const extId = `ebay:${marketplaceId}:${safeExt}`;
  const soldCount = Number(
    item?.itemSales?.itemSalesCount ??
      item?.itemLocation?.itemSalesCount ??
      item?.buyingOptions?.soldCount ??
      item?.soldCount
  );
  const reviewCount = Number(
    item?.seller?.feedbackScore ??
      item?.seller?.feedbackPercentage ??
      item?.reviews?.reviewCount ??
      item?.reviewCount
  );
  const rating = Number(
    item?.reviews?.averageRating ??
      item?.seller?.feedbackPercentage
  );
  const listingDate =
    item?.itemCreationDate ||
    item?.itemStartDate ||
    item?.listingDate ||
    null;
  const variants = normalizeVariants(
    [
      {
        size: null,
        color: inferProductColor(title),
        price,
        available: true,
      },
    ],
    { size: "unknown", color: inferProductColor(title), price, available: true }
  );

  return {
    title,
    price,
    image: improveImageUrlQuality(imageList[0] || selected.image || img),
    externalId: extId,
    category: normalizeCategoryId(inferCategory(title)),
    color: inferProductColor(title),
    sourcePlatform: "eBay",
    sourceName: seller.slice(0, 120),
    sourceUrl: webUrl || ctxUrl,
    sourceProductId: itemId,
    supplierName: seller.slice(0, 120),
    supplierCountry: (process.env.DISCOVERY_DEFAULT_SUPPLIER_COUNTRY || "").trim(),
    importMethod: "ebay_browse_api",
    sourceQuery: String(sourceQuery || "").trim(),
    discovery_selection_mode: String(selectionMode || "unknown"),
    discovery_query_confidence: String(queryConfidence || "low"),
    images: imageList,
    variants,
    available: variants.some((v) => v.available !== false),
    sold_count: Number.isFinite(soldCount) ? soldCount : null,
    review_count: Number.isFinite(reviewCount) ? reviewCount : null,
    rating: Number.isFinite(rating) ? rating : null,
    listing_date: listingDate ? String(listingDate) : null,
  };
}

/**
 * @param {number} limit
 * @param {{ storeConfig?: object | null }} [options]
 * @returns {Promise<Array<object>>}
 */
async function fetchEbayProductCandidates(limit, options = {}) {
  if (limit <= 0) return [];
  const storeConfig = options.storeConfig || null;
  if (!isEbaySourcingActive(storeConfig)) return [];

  const auth = await getEbayAccessTokenFromIntegrations(storeConfig.integrations);
  if (!auth.ok || !auth.accessToken) {
    console.warn("[sourcing/ebay] Ingen token:", auth.error || "?");
    return [];
  }

  const marketplaceId = ebayMarketplaceId();
  const variants = pickEbayQueryVariants(storeConfig, options, 3);
  const out = [];
  let rejectedNegative = 0;
  let rejectedOffTopic = 0;
  const pageSize = Math.min(50, Math.max(limit, 5));
  let pagesTried = 0;
  const strictCategory = Boolean(options.categoryIntent && options.chatMode);
  let selectedVariant = variants[0] || pickEbayQueryVariant(storeConfig, options);

  for (const picked of variants) {
    if (out.length >= limit) break;
    selectedVariant = picked;
    let offset = 0;
    let localPages = 0;
    while (out.length < limit && offset < 250 && localPages < 3) {
      pagesTried += 1;
      localPages += 1;
      const res = await ebayBrowseItemSummarySearch(auth.accessToken, auth.sandbox, {
        q: picked.query,
        limit: pageSize,
        offset,
      });
      if (!res.ok) {
        console.warn("[sourcing/ebay] Browse search:", res.error || res.status);
        break;
      }
      const items = res.items || [];
      for (const it of items) {
        const row = ebayItemToDiscoveryCandidate(
          it,
          marketplaceId,
          picked.query,
          picked.selectionMode || "unknown",
          picked.confidence || "low"
        );
        if (!row.title || row.price <= 0 || !String(row.image || "").trim()) {
          if (!String(row.image || "").trim()) {
            console.log("[discovery:image] reject", {
              provider: "ebay",
              reason: "no_valid_image",
              title: String(row.title || "").slice(0, 140),
              sourceUrl: String(row.sourceUrl || ""),
            });
          }
          continue;
        }
        if (blockedByNegativeTitleTerms(row.title, picked.negative || [])) {
          rejectedNegative += 1;
          continue;
        }
        const relevanceReject = categoryRelevanceRejectReason(
          row.title,
          picked.categoryId || options.categoryIntent || row.category,
          strictCategory
        );
        if (relevanceReject) {
          rejectedOffTopic += 1;
          continue;
        }
        out.push(row);
        if (out.length >= limit) break;
      }
      if (items.length < pageSize) break;
      offset += pageSize;
    }
  }

  if (options.discoveryLog) {
    await options.discoveryLog("sourcing_marketplace_query", {
      runId: options.runId || null,
      cycleId: options.cycleId || null,
      source: "ebay",
      selectedCategory: selectedVariant.categoryId || null,
      queryType: selectedVariant.type || null,
      query: selectedVariant.query,
      queryVariantsTried: variants.map((v) => v.query).slice(0, 6),
      negativeTerms: selectedVariant.negative || [],
      pagesTried,
      itemsCollected: out.length,
      rejectedNegative,
      rejectedOffTopic,
      strictCategory,
      debug: selectedVariant.debug || {},
      exploration: (selectedVariant.debug && selectedVariant.debug.exploration) || null,
    });
  }

  return out.slice(0, limit);
}

module.exports = {
  isEbaySourcingActive,
  fetchEbayProductCandidates,
  providerListAllowsEbay,
  ebayIntegrationConfigured,
};
