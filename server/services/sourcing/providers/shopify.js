/**
 * Shopify som sourcing-provider: Admin REST (med token + *.myshopify.com)
 * eller offentlig storefront JSON (fallback / uden token).
 *
 * Kandidater mapper til samme rå form som `discovery.js` (title, price, image, …).
 */

const {
  validatePublicShopOrigin,
  resolveShopifyFetchTarget,
  fetchShopifyProductsUpTo,
  fetchShopifyAdminProductsUpTo,
  resolveShopifyAdminCollectionId,
  shopifyProductToDiscoveryCandidate,
  extractMyshopifyHost,
} = require("../../shopify-import");

function providerListAllowsShopify(storeConfig) {
  const es = storeConfig && storeConfig.enabledSources;
  if (!Array.isArray(es) || !es.length) return true;
  const tokens = es.map((s) => String(s || "").toLowerCase());
  return tokens.some((t) => t.includes("shopify"));
}

function normalizeAdminShopHostInput(raw) {
  let h = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0];
  if (!h) return null;
  if (!h.endsWith(".myshopify.com")) {
    const sub = h.replace(/\.myshopify\.com$/i, "");
    if (!sub || /[^a-z0-9-]/.test(sub)) return null;
    h = `${sub}.myshopify.com`;
  }
  return h;
}

/**
 * @param {object | null | undefined} storeConfig
 * @returns {boolean}
 */
function isShopifySourcingActive(storeConfig) {
  if (!storeConfig || !providerListAllowsShopify(storeConfig)) return false;
  const p = storeConfig.sourcing && storeConfig.sourcing.providers && storeConfig.sourcing.providers.shopify;
  if (!p || typeof p !== "object" || p.enabled !== true) return false;
  const url = String(p.storeUrl || "").trim();
  if (!/^https:\/\//i.test(url)) return false;
  return true;
}

function resolveMyshopifyHostForAdmin(storeConfig) {
  const p = storeConfig && storeConfig.sourcing && storeConfig.sourcing.providers && storeConfig.sourcing.providers.shopify;
  if (!p) return null;
  const explicit = normalizeAdminShopHostInput(p.adminShopHost || p.myshopifyHost);
  if (explicit) return explicit;
  return extractMyshopifyHost(p.storeUrl);
}

/**
 * @param {number} limit
 * @param {{ storeConfig?: object | null, chatMode?: boolean }} [options]
 * @returns {Promise<Array<object>>}
 */
async function fetchShopifyProductCandidates(limit, options = {}) {
  if (limit <= 0) return [];
  const storeConfig = options.storeConfig || null;
  if (!isShopifySourcingActive(storeConfig)) return [];

  const p = storeConfig.sourcing.providers.shopify;
  const storeUrl = String(p.storeUrl || "").trim();
  const token = String(p.accessToken || "").trim();
  let collectionHandle = String(p.collectionHandle || "").trim().replace(/^\/+|\/+$/g, "");
  const resolved = resolveShopifyFetchTarget(storeUrl);
  if (resolved.error) {
    console.warn("[sourcing/shopify] Ugyldig butiks-URL:", resolved.error);
    return [];
  }
  const origin = resolved.origin;
  if (!collectionHandle && resolved.collectionHandle) collectionHandle = resolved.collectionHandle;

  const adminHost = resolveMyshopifyHostForAdmin(storeConfig);
  let products = [];
  let importMethod = "shopify_storefront_json";

  if (adminHost && token.length >= 8) {
    importMethod = "shopify_api";
    let collectionId = null;
    if (collectionHandle) {
      collectionId = await resolveShopifyAdminCollectionId(adminHost, token, collectionHandle);
      if (!collectionId) {
        console.warn("[sourcing/shopify] Ingen Admin-kollektion for handle:", collectionHandle);
      }
    }
    try {
      products = await fetchShopifyAdminProductsUpTo(adminHost, token, limit, {
        collectionId: collectionId || undefined,
      });
    } catch (e) {
      console.warn("[sourcing/shopify] Admin API:", e.message || e);
      products = [];
    }
  }

  if (!products.length) {
    const vpo = validatePublicShopOrigin(storeUrl);
    if (vpo.error) {
      if (adminHost && token.length >= 8) {
        console.warn("[sourcing/shopify] Ingen kandidater (Admin fejlede / tom), og offentlig URL kunne ikke valideres.");
      }
      return [];
    }
    try {
      products = await fetchShopifyProductsUpTo(origin, collectionHandle || null, limit);
      importMethod = "shopify_storefront_json";
    } catch (e) {
      console.warn("[sourcing/shopify] Storefront JSON:", e.message || e);
      return [];
    }
  }

  const sourceQuery = collectionHandle ? `shopify collection ${collectionHandle}` : "shopify catalog";
  const out = [];
  for (const prod of products) {
    const row = shopifyProductToDiscoveryCandidate(prod, origin, importMethod);
    if (!row.title || row.price <= 0 || !String(row.image || "").trim()) continue;
    out.push({
      ...row,
      sourceQuery,
      discovery_selection_mode: "exploit",
      discovery_query_confidence: "high",
    });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = {
  isShopifySourcingActive,
  fetchShopifyProductCandidates,
  providerListAllowsShopify,
};
