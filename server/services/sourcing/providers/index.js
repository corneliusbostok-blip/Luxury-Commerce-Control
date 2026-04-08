/**
 * Sourcing provider registry — udvid med shopify / ebay / … senere.
 * I dag: kun HTTP/seed-baseret "web" discovery er implementeret (discovery.js).
 */

const { normalizeCategoryId } = require("../../category");
const shopify = require("./shopify");
const ebay = require("./ebay");
const amazon = require("./amazon");
const aliexpress = require("./aliexpress");

const MAX_SEED_URL_LEN = 2048;

const MERCH_FOCUS_IDS = ["balanced", "trending", "seasonal", "timeless"];

function defaultMerchandising() {
  return { focus: "balanced", seasonNote: "", vibeKeywords: "" };
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function normalizeMerchFocus(v) {
  const s = String(v || "").trim().toLowerCase();
  return MERCH_FOCUS_IDS.includes(s) ? s : "balanced";
}

/**
 * @param {unknown} u
 * @returns {string | null}
 */
function sanitizeHttpSeedUrl(u) {
  const s = String(u || "").trim();
  if (s.length < 12 || s.length > MAX_SEED_URL_LEN) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return s.split("#")[0];
  } catch {
    return null;
  }
}

const PROVIDER_SECRET_KEYS = ["accessToken", "appSecret", "clientSecret", "oauthToken"];

function stripEmptyProviderSecrets(obj) {
  if (!obj || typeof obj !== "object") return;
  for (const key of PROVIDER_SECRET_KEYS) {
    if (obj[key] !== undefined && String(obj[key]).trim() === "") delete obj[key];
  }
}

function defaultProviders() {
  return {
    web: {
      enabled: true,
      /** Fælles seed-URL'er (https), merges med DISCOVERY_SEED_* env */
      seedUrls: [],
      /** { "shirts": ["https://..."], ... } */
      seedsByCategory: {},
    },
    shopify: {
      enabled: false,
      storeUrl: "",
      accessToken: "",
      /** Valgfrit: begræns discovery/importer til én kollektion (handle). */
      collectionHandle: "",
      /** Når `storeUrl` er custom domæne: `butik.myshopify.com` til Admin API. */
      adminShopHost: "",
    },
    ebay: {
      enabled: false,
    },
    amazon: {
      enabled: false,
      region: "US",
      rapidApiHost: "real-time-amazon-data.p.rapidapi.com",
      rapidApiKey: "",
    },
    aliexpress: {
      enabled: false,
      rapidApiHost: "aliexpress-datahub.p.rapidapi.com",
      rapidApiKey: "",
    },
    alibaba: { enabled: false },
    cjdropshipping: { enabled: false },
  };
}

/**
 * @param {unknown} raw
 * @returns {{ defaultProvider: string, providers: Record<string, any>, merchandising: { focus: string, seasonNote: string, vibeKeywords: string } }}
 */
function normalizeSourcingBlock(raw) {
  const base = {
    defaultProvider: "web",
    providers: defaultProviders(),
    merchandising: defaultMerchandising(),
  };
  if (!raw || typeof raw !== "object") return base;
  const src = /** @type {Record<string, any>} */ (raw);
  const defaultProvider = String(src.defaultProvider || base.defaultProvider).trim() || "web";
  const pin = src.providers && typeof src.providers === "object" ? src.providers : {};
  const mergedProviders = { ...defaultProviders() };
  for (const key of Object.keys(mergedProviders)) {
    const patch = pin[key];
    if (!patch || typeof patch !== "object") continue;
    mergedProviders[key] = { ...mergedProviders[key], ...patch };
  }
  if (mergedProviders.web) {
    const w = mergedProviders.web;
    w.seedUrls = Array.isArray(w.seedUrls)
      ? [...new Set(w.seedUrls.map((u) => sanitizeHttpSeedUrl(u)).filter(Boolean))]
      : [];
    const byCat = w.seedsByCategory && typeof w.seedsByCategory === "object" ? w.seedsByCategory : {};
    const outCat = {};
    for (const [ck, list] of Object.entries(byCat)) {
      const id = normalizeCategoryId(ck);
      if (!id) continue;
      outCat[id] = [
        ...new Set((Array.isArray(list) ? list : []).map((u) => sanitizeHttpSeedUrl(u)).filter(Boolean)),
      ];
    }
    w.seedsByCategory = outCat;
    if (typeof w.enabled !== "boolean") w.enabled = true;
  }
  if (mergedProviders.shopify) {
    const sh = mergedProviders.shopify;
    sh.storeUrl = String(sh.storeUrl || "")
      .trim()
      .replace(/\/+$/, "");
    sh.collectionHandle = String(sh.collectionHandle || "")
      .trim()
      .replace(/^\/+|\/+$/g, "");
    let ash = String(sh.adminShopHost || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .split("/")[0];
    if (ash && !ash.endsWith(".myshopify.com")) {
      const sub = ash.replace(/\.myshopify\.com$/i, "");
      if (sub && !/[^a-z0-9-]/.test(sub)) ash = `${sub}.myshopify.com`;
      else ash = "";
    }
    sh.adminShopHost = ash.endsWith(".myshopify.com") ? ash : "";
  }
  for (const k of Object.keys(mergedProviders)) {
    if (k === "web") continue;
    const p = mergedProviders[k];
    if (p && typeof p.enabled !== "boolean") p.enabled = false;
    for (const secretKey of ["accessToken", "appSecret", "clientSecret", "oauthToken"]) {
      if (p[secretKey] != null && typeof p[secretKey] !== "string") p[secretKey] = String(p[secretKey]);
    }
  }
  const msrc = src.merchandising && typeof src.merchandising === "object" ? src.merchandising : {};
  const merchandising = {
    ...defaultMerchandising(),
    focus: normalizeMerchFocus(msrc.focus),
    seasonNote: String(msrc.seasonNote || "").trim().slice(0, 160),
    vibeKeywords: String(msrc.vibeKeywords || "").trim().slice(0, 500),
  };
  return { defaultProvider, providers: mergedProviders, merchandising };
}

/**
 * @param {object | null | undefined} storeConfig
 * @returns {boolean}
 */
function isWebDiscoveryEnabled(storeConfig) {
  const w = storeConfig && storeConfig.sourcing && storeConfig.sourcing.providers && storeConfig.sourcing.providers.web;
  if (!w || typeof w !== "object") return true;
  return w.enabled !== false;
}

/**
 * Om HTTP/scrape-discovery må køre under nuværende `enabledSources`.
 * Tom liste = ingen kildebegrænsning (legacy/åben).
 * @param {object | null | undefined} storeConfig
 * @returns {boolean}
 */
function enabledSourcesAllowWebScrape(storeConfig) {
  if (!storeConfig || !Array.isArray(storeConfig.enabledSources) || !storeConfig.enabledSources.length) {
    return true;
  }
  const tokens = storeConfig.enabledSources.map((s) => String(s || "").toLowerCase()).filter(Boolean);
  return tokens.some((t) => ["web", "http", "https", "discovery", "scrape"].includes(t));
}

/**
 * Seed-URL'er fra tenant config (https), deduped.
 * @param {object | null | undefined} storeConfig
 * @param {string | null | undefined} categoryId
 * @returns {string[]}
 */
function webSeedUrlsFromConfig(storeConfig, categoryId) {
  const w =
    storeConfig &&
    storeConfig.sourcing &&
    storeConfig.sourcing.providers &&
    storeConfig.sourcing.providers.web;
  if (!w || typeof w !== "object") return [];
  const seen = new Set();
  const out = [];
  function push(list) {
    for (const u of list || []) {
      const s = sanitizeHttpSeedUrl(u);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  push(w.seedUrls);
  const cat = categoryId ? normalizeCategoryId(categoryId) : null;
  if (cat && cat !== "other" && w.seedsByCategory && w.seedsByCategory[cat]) {
    push(w.seedsByCategory[cat]);
  }
  return out;
}

/**
 * Dyb merge af sourcing-patch ind i eksisterende config (fx partial update fra admin).
 * @param {unknown} baseRaw
 * @param {unknown} patchRaw
 * @returns {{ defaultProvider: string, providers: Record<string, any> }}
 */
function mergeSourcingPatch(baseRaw, patchRaw) {
  const base = normalizeSourcingBlock(baseRaw);
  const patch = patchRaw && typeof patchRaw === "object" ? /** @type {Record<string, any>} */ (patchRaw) : {};
  const next = {
    defaultProvider: patch.defaultProvider != null ? String(patch.defaultProvider).trim() : base.defaultProvider,
    providers: { ...base.providers },
    merchandising: {
      ...base.merchandising,
      ...(patch.merchandising && typeof patch.merchandising === "object" ? patch.merchandising : {}),
    },
  };
  const pp = patch.providers && typeof patch.providers === "object" ? patch.providers : {};
  for (const [k, v] of Object.entries(pp)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const patchClean = { ...v };
      stripEmptyProviderSecrets(patchClean);
      if (next.providers[k] && typeof next.providers[k] === "object" && !Array.isArray(next.providers[k])) {
        next.providers[k] = { ...next.providers[k], ...patchClean };
      } else if (v !== undefined) {
        next.providers[k] = patchClean;
      }
    } else if (v !== undefined) {
      next.providers[k] = v;
    }
  }
  return normalizeSourcingBlock(next);
}

module.exports = {
  normalizeSourcingBlock,
  mergeSourcingPatch,
  defaultMerchandising,
  MERCH_FOCUS_IDS,
  isWebDiscoveryEnabled,
  enabledSourcesAllowWebScrape,
  webSeedUrlsFromConfig,
  sanitizeHttpSeedUrl,
  defaultProviders,
  shopify,
  isShopifySourcingActive: shopify.isShopifySourcingActive,
  fetchShopifyProductCandidates: shopify.fetchShopifyProductCandidates,
  isEbaySourcingActive: ebay.isEbaySourcingActive,
  fetchEbayProductCandidates: ebay.fetchEbayProductCandidates,
  ebayIntegrationConfigured: ebay.ebayIntegrationConfigured,
  isAmazonSourcingActive: amazon.isAmazonSourcingActive,
  fetchAmazonProductCandidates: amazon.fetchAmazonProductCandidates,
  isAliExpressSourcingActive: aliexpress.isAliExpressSourcingActive,
  fetchAliExpressProductCandidates: aliexpress.fetchAliExpressProductCandidates,
};
