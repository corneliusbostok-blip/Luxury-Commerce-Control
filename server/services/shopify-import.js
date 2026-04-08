/**
 * Henter produkter fra en offentlig Shopify-butik:
 * - Hele kataloget: GET /products.json (paginering via since_id)
 * - Én kollektion: GET /collections/{handle}/products.json (paginering via page=)
 *
 * URL kan være rod (https://shop.dk) eller kollektion (https://shop.dk/collections/handle).
 * Bruges kun hvor du har ret til at bruge data — tjek vilkår og ophavsret.
 */
const { normalizeDiscoveredPriceToDkk } = require("./currency");
const { priceFromCostDeterministic } = require("./pricing");
const { inferCategory, inferProductColor, normalizeCategoryId } = require("./category");
const { normalizeImages, normalizeVariants } = require("./product-sync-normalizer");

const USER_AGENT =
  process.env.DISCOVERY_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SHOPIFY_ADMIN_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || "2024-10";

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validatePublicShopOrigin(input) {
  let u;
  try {
    u = new URL(String(input || "").trim());
  } catch {
    return { error: "Ugyldig URL" };
  }
  if (!/^https?:$/i.test(u.protocol)) return { error: "Kun http(s) er tilladt" };
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".local") ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return { error: "Interne eller lokale hosts er ikke tilladt" };
  }
  return { origin: u.origin.replace(/\/$/, "") };
}

/**
 * @param {string} input — shop-rod eller fuld kollektions-URL
 * @returns {{ error?: string, origin: string, collectionHandle: string | null }}
 */
function resolveShopifyFetchTarget(input) {
  const v = validatePublicShopOrigin(input);
  if (v.error) return { error: v.error, origin: "", collectionHandle: null };
  let u;
  try {
    u = new URL(String(input || "").trim());
  } catch {
    return { error: "Ugyldig URL", origin: "", collectionHandle: null };
  }
  const m = u.pathname.match(/\/collections\/([^/?#]+)/i);
  const collectionHandle = m ? decodeURIComponent(m[1]) : null;
  return { origin: v.origin, collectionHandle };
}

function mapShopifyProductTypeToHint(productType, tags) {
  const parts = [];
  if (productType) parts.push(String(productType));
  if (Array.isArray(tags)) parts.push(tags.join(" "));
  const s = parts.join(" ").toLowerCase();
  if (!s.trim()) return "";
  if (/\bpolo\b/.test(s)) return "polos";
  if (/knit|sweater|cardigan|pullover|knitwear/.test(s)) return "knitwear";
  if (/linen\s+shirt|shirt|skjorte/.test(s)) return "shirts";
  if (/pant|trouser|chino|bukser/.test(s)) return "trousers";
  if (/jacket|coat|blazer|outer/.test(s)) return "outerwear";
  if (/shoe|loafer|boot|sandal|sneaker|espadrille/.test(s)) return "shoes";
  if (/watch/.test(s)) return "watches";
  return "";
}

function variantSizesHint(p) {
  const opt = (p.options || []).find((o) => /size/i.test(String(o.name || "")));
  if (opt && opt.values && opt.values.length) return opt.values.join(",");
  const seen = new Set();
  for (const va of p.variants || []) {
    const s = String(va.option1 || "").trim();
    if (s && !/^(default|title)$/i.test(s)) seen.add(s);
  }
  const arr = [...seen];
  if (arr.length) return arr.join(",");
  return "S,M,L,XL";
}

async function fetchJsonWithTimeout(url, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {string} storeUrl
 * @returns {string | null} — hostname *.myshopify.com
 */
function extractMyshopifyHost(storeUrl) {
  try {
    const h = new URL(String(storeUrl || "").trim()).hostname.toLowerCase();
    return h.endsWith(".myshopify.com") ? h : null;
  } catch {
    return null;
  }
}

/**
 * @param {string | unknown} linkHeader — Shopify Admin `Link` header
 * @returns {string | null} full next URL
 */
function parseAdminLinkNext(linkHeader) {
  if (!linkHeader || typeof linkHeader !== "string") return null;
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const m = part.trim().match(/^<([^>]+)>;\s*rel="next"/);
    if (m) return m[1].trim();
  }
  return null;
}

async function fetchJsonAdmin(url, accessToken, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
        "User-Agent": USER_AGENT,
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Højst `maxItems` produkter fra offentlig storefront JSON ( hurtig stop, til discovery ).
 * @param {string} origin
 * @param {string | null} collectionHandle
 * @param {number} maxItems
 */
async function fetchShopifyProductsUpTo(origin, collectionHandle, maxItems) {
  const cap = Math.max(0, Math.min(Number(maxItems) || 0, 500));
  if (cap <= 0) return [];
  const base = String(origin || "").replace(/\/+$/, "");
  const out = [];
  if (collectionHandle) {
    const handle = String(collectionHandle || "")
      .trim()
      .replace(/^\/+|\/+$/g, "");
    if (!handle) return [];
    for (let page = 1; page < 200 && out.length < cap; page++) {
      const need = cap - out.length;
      const limit = Math.min(250, need);
      const url = `${base}/collections/${encodeURIComponent(handle)}/products.json?limit=${limit}&page=${page}`;
      const r = await fetchJsonWithTimeout(url, 60000);
      if (!r.ok) {
        const err = new Error(`Shopify collection products HTTP ${r.status} (${handle})`);
        err.status = r.status;
        throw err;
      }
      const j = await r.json();
      const products = j.products || [];
      if (!products.length) break;
      out.push(...products);
      if (products.length < limit) break;
    }
  } else {
    let sinceId = 0;
    for (let guard = 0; guard < 200 && out.length < cap; guard++) {
      const need = cap - out.length;
      const limit = Math.min(250, need);
      const q = sinceId ? `limit=${limit}&since_id=${sinceId}` : `limit=${limit}`;
      const url = `${base}/products.json?${q}`;
      const r = await fetchJsonWithTimeout(url, 60000);
      if (!r.ok) {
        const err = new Error(`Shopify products.json HTTP ${r.status}`);
        err.status = r.status;
        throw err;
      }
      const j = await r.json();
      const products = j.products || [];
      if (!products.length) break;
      out.push(...products);
      sinceId = products[products.length - 1].id;
      if (products.length < limit) break;
    }
  }
  return out.slice(0, cap);
}

/**
 * @param {string} shopHost — *.myshopify.com
 * @param {string} accessToken
 * @param {string} handle — kollektions-handle
 */
async function resolveShopifyAdminCollectionId(shopHost, accessToken, handle) {
  const h = encodeURIComponent(String(handle || "").trim());
  if (!h) return null;
  for (const resource of ["custom_collections", "smart_collections"]) {
    const url = `https://${shopHost}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/${resource}.json?handle=${h}`;
    const r = await fetchJsonAdmin(url, accessToken, 30000);
    if (!r.ok) continue;
    const j = await r.json();
    const key = resource === "custom_collections" ? "custom_collections" : "smart_collections";
    const arr = j[key] || [];
    if (arr[0] && arr[0].id) return arr[0].id;
  }
  return null;
}

/**
 * @param {string} shopHost
 * @param {string} accessToken
 * @param {number} maxItems
 * @param {{ collectionId?: number | string | null }} [opts]
 */
async function fetchShopifyAdminProductsUpTo(shopHost, accessToken, maxItems, opts = {}) {
  const cap = Math.max(0, Math.min(Number(maxItems) || 0, 500));
  if (cap <= 0) return [];
  const collectionId = opts.collectionId != null && String(opts.collectionId).trim() !== "" ? opts.collectionId : null;
  const basePath = `https://${shopHost}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/products.json`;
  const out = [];
  let nextUrl = null;
  for (let guard = 0; guard < 250 && out.length < cap; guard++) {
    const need = cap - out.length;
    const lim = Math.min(250, need);
    let reqUrl;
    if (nextUrl) {
      reqUrl = nextUrl;
    } else {
      const u = new URL(basePath);
      u.searchParams.set("limit", String(lim));
      if (collectionId != null) u.searchParams.set("collection_id", String(collectionId));
      reqUrl = u.toString();
    }
    const r = await fetchJsonAdmin(reqUrl, accessToken);
    if (!r.ok) {
      const err = new Error(`Shopify Admin products HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    const j = await r.json();
    const products = j.products || [];
    for (const p of products) {
      if (out.length >= cap) break;
      out.push(p);
    }
    if (out.length >= cap) break;
    nextUrl = parseAdminLinkNext(r.headers.get("link"));
    if (!products.length || !nextUrl) break;
  }
  return out.slice(0, cap);
}

/**
 * Shopify product JSON (storefront eller Admin REST) → samme rå form som `discovery.js`.
 * @param {object} p
 * @param {string} origin — offentlig butiksrod (til permalinks og valuta-heuristik)
 * @param {string} importMethod — fx shopify_api | shopify_storefront_json
 */
function shopifyProductToDiscoveryCandidate(p, origin, importMethod) {
  const v = p.variants && p.variants[0] ? p.variants[0] : {};
  const rawPrice = parseFloat(String(v.price || "0")) || 0;
  const root = String(origin || "").replace(/\/+$/, "");
  const productUrl = `${root}/products/${encodeURIComponent(p.handle || String(p.id))}`;
  const price = normalizeDiscoveredPriceToDkk(rawPrice, "", productUrl);
  const hostKey = shopifyHostKey(root);
  const extId = `shopify:${hostKey}:${p.id}`;
  const allImages = normalizeImages(
    Array.isArray(p.images) ? p.images.map((x) => x && x.src).filter(Boolean) : [],
    p.image && p.image.src ? p.image.src : ""
  );
  const img = allImages[0] || "";
  const rawVariants = Array.isArray(p.variants)
    ? p.variants.map((vv) => ({
        size: String(vv.option1 || "").trim() || null,
        color: String(vv.option2 || "").trim() || null,
        price: parseFloat(String(vv.price || "0")) || rawPrice,
        available: vv.available != null ? Boolean(vv.available) : true,
      }))
    : [];
  const variants = normalizeVariants(rawVariants, {
    size: "unknown",
    color: inferProductColor(p.title),
    price,
    available: true,
  });
  const hint = mapShopifyProductTypeToHint(p.product_type, p.tags);
  const category = normalizeCategoryId(inferCategory(String(p.title || "").trim(), hint));
  const brand = String(p.vendor || "").trim();
  const platform = "Shopify";
  const sourceName = (brand || hostKey).slice(0, 120);

  return {
    title: String(p.title || "").trim(),
    price,
    image: img,
    externalId: extId,
    category,
    color: inferProductColor(p.title),
    sourcePlatform: platform,
    sourceName,
    sourceUrl: productUrl,
    sourceProductId: String(p.id),
    supplierName: (brand || sourceName).slice(0, 120),
    supplierCountry: (process.env.DISCOVERY_DEFAULT_SUPPLIER_COUNTRY || "").trim(),
    importMethod: String(importMethod || "shopify_storefront_json"),
    images: allImages,
    variants,
    available: variants.some((v) => v.available !== false),
  };
}

async function fetchAllShopifyProducts(origin) {
  const all = [];
  let sinceId = 0;
  for (let guard = 0; guard < 200; guard++) {
    const q = sinceId ? `limit=250&since_id=${sinceId}` : "limit=250";
    const url = `${origin}/products.json?${q}`;
    const r = await fetchJsonWithTimeout(url, 60000);
    if (!r.ok) {
      const err = new Error(`Shopify products.json HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    const j = await r.json();
    const products = j.products || [];
    if (!products.length) break;
    all.push(...products);
    sinceId = products[products.length - 1].id;
    if (products.length < 250) break;
  }
  return all;
}

/** Kollektionssider bruger typisk page= (Shopify storefront JSON). */
async function fetchAllShopifyCollectionProducts(origin, collectionHandle) {
  const handle = String(collectionHandle || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!handle) throw new Error("Mangler kollektions-handle");
  const all = [];
  for (let page = 1; page < 200; page++) {
    const url = `${origin}/collections/${encodeURIComponent(handle)}/products.json?limit=250&page=${page}`;
    const r = await fetchJsonWithTimeout(url, 60000);
    if (!r.ok) {
      const err = new Error(`Shopify collection products HTTP ${r.status} (${handle})`);
      err.status = r.status;
      throw err;
    }
    const j = await r.json();
    const products = j.products || [];
    if (!products.length) break;
    all.push(...products);
    if (products.length < 250) break;
  }
  return all;
}

async function fetchShopifyProductsForTarget(origin, collectionHandle) {
  if (collectionHandle) return fetchAllShopifyCollectionProducts(origin, collectionHandle);
  return fetchAllShopifyProducts(origin);
}

function shopifyHostKey(origin) {
  try {
    return new URL(origin).hostname.replace(/^www\./i, "");
  } catch {
    return "shop";
  }
}

function buildRowFromShopifyProduct(p, origin, opts = {}) {
  const v = p.variants && p.variants[0] ? p.variants[0] : {};
  const rawPrice = parseFloat(String(v.price || "0")) || 0;
  const productUrl = `${origin}/products/${encodeURIComponent(p.handle || String(p.id))}`;
  /** Shopify-variantpris er i butikkens valuta; .dk → DKK via URL, øvrige via env/fallback (typisk EUR). */
  const cost = normalizeDiscoveredPriceToDkk(rawPrice, "", productUrl);
  const hostKey = shopifyHostKey(origin);
  const extId = `shopify:${hostKey}:${p.id}`;
  const price = priceFromCostDeterministic(cost, extId);
  const hint =
    (opts.forceCategory && String(opts.forceCategory).trim()) ||
    mapShopifyProductTypeToHint(p.product_type, p.tags);
  const category = normalizeCategoryId(inferCategory(p.title, hint));
  const img = p.images && p.images[0] ? p.images[0].src : "";
  const desc = stripHtml(p.body_html).slice(0, 4000);
  const brand = String(
    p.vendor || process.env.CATALOG_DEFAULT_BRAND || "BAHR & Co"
  ).slice(0, 120);

  return {
    name: String(p.title || "Product").slice(0, 200),
    cost,
    price,
    score: 0,
    status: "active",
    sourcing_status: "approved",
    brand,
    description: desc || `${p.title} — quiet luxury.`,
    selling_points: "Tidløs herrestil | Diskret kvalitet",
    image_url: img,
    external_id: extId,
    category,
    color: inferProductColor(p.title),
    sizes: variantSizesHint(p),
    source_platform: "Shopify",
    source_name: String(p.vendor || "Shopify").slice(0, 120),
    source_url: productUrl,
    source_product_id: String(p.id),
    supplier_name: "",
    supplier_country: "",
    import_method: opts.collectionHandle
      ? `shopify_collection:${opts.collectionHandle}`
      : "shopify_products_json",
    ai_fit_score: 75,
    brand_fit_reason: "Importeret via Shopify JSON (admin/script).",
  };
}

/**
 * @param {string} shopUrl — butiksrod eller /collections/handle-URL
 * @param {{ forceCategory?: string, collectionHandle?: string | null }} [opts] — collectionHandle overstyrer parsed handle fra URL
 * @returns {Promise<{ ok: boolean, origin?: string, collectionHandle?: string | null, rows?: object[], error?: string, productCount?: number }>}
 */
async function loadShopifyProductRows(shopUrl, opts = {}) {
  const resolved = resolveShopifyFetchTarget(shopUrl);
  if (resolved.error) return { ok: false, error: resolved.error };
  const origin = resolved.origin;
  let collectionHandle =
    opts.collectionHandle != null && String(opts.collectionHandle).trim() !== ""
      ? String(opts.collectionHandle).trim().replace(/^\/+|\/+$/g, "")
      : resolved.collectionHandle;
  let products;
  try {
    products = await fetchShopifyProductsForTarget(origin, collectionHandle);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  const buildOpts = {
    forceCategory: opts.forceCategory,
    collectionHandle: collectionHandle || null,
  };
  const rows = products.map((p) => buildRowFromShopifyProduct(p, origin, buildOpts));
  return {
    ok: true,
    origin,
    collectionHandle: collectionHandle || null,
    rows,
    productCount: rows.length,
  };
}

module.exports = {
  validatePublicShopOrigin,
  resolveShopifyFetchTarget,
  loadShopifyProductRows,
  extractMyshopifyHost,
  fetchShopifyProductsUpTo,
  fetchShopifyAdminProductsUpTo,
  resolveShopifyAdminCollectionId,
  shopifyProductToDiscoveryCandidate,
  parseAdminLinkNext,
  SHOPIFY_ADMIN_API_VERSION,
};
