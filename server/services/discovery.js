/**
 * Velden product discovery — live HTTP only.
 *
 * Flere kilder: web, Shopify og eBay kan alle bidrage; kvote fordeles når flere er aktive.
 * eBay: Browse API efter integration + provider «enabled». autoProductImport=false stopper automatisk hentning (ikke chat).
 * Flow: seed URLs → fetch (browser-like UA, timeout) → parse JSON-LD (Product, @graph,
 * ItemList) → supplement og/twitter price & image → BFS same-host links → candidates for sourcing.
 *
 * Env:
 *   DISCOVERY_SEED_URLS              — optional global seeds (comma-separated https), merged with category lists
 *   DISCOVERY_SEED_SHIRTS            — seeds when sourcing shirts (also used for sourcing chat with shirt intent)
 *   DISCOVERY_SEED_TROUSERS, _OUTERWEAR, _KNITWEAR, _SHOES, _WATCHES, _ACCESSORIES, _OTHER — same pattern
 *   DISCOVERY_FETCH_TIMEOUT_MS       — default 18000
 *   DISCOVERY_MAX_PAGE_FETCHES       — default 28 (ceiling 60)
 *   DISCOVERY_DEFAULT_SUPPLIER_COUNTRY — e.g. DK
 *   DISCOVERY_USER_AGENT             — optional override
 *
 * Respect robots.txt and each site's terms of use.
 */

const cheerio = require("cheerio");
const { inferCategory, inferProductColor, normalizeCategoryId } = require("./category");
const { normalizeDiscoveredPriceToDkk } = require("./currency");
const { titleFailsVeldenBrief } = require("./sourcing");
const { normalizeImages, normalizeVariants } = require("./product-sync-normalizer");
const {
  queryPerformanceMap,
  categoryPerformanceMap,
  computeDiscoveryScore,
  sortCandidatesByDiscoveryScore,
  recordDiscoveredCandidates,
} = require("./discovery-intelligence");
const {
  isWebDiscoveryEnabled,
  enabledSourcesAllowWebScrape,
  webSeedUrlsFromConfig,
  isShopifySourcingActive,
  fetchShopifyProductCandidates,
  isEbaySourcingActive,
  fetchEbayProductCandidates,
  isAmazonSourcingActive,
  fetchAmazonProductCandidates,
  isAliExpressSourcingActive,
  fetchAliExpressProductCandidates,
} = require("./sourcing/providers");
const { generateCategoryQueryPack } = require("./sourcing/query-engine");

/** Maps Velden category slug → process.env key for comma-separated https seeds. */
const CATEGORY_SEED_ENV = {
  polos: "DISCOVERY_SEED_POLOS",
  shirts: "DISCOVERY_SEED_SHIRTS",
  trousers: "DISCOVERY_SEED_TROUSERS",
  outerwear: "DISCOVERY_SEED_OUTERWEAR",
  knitwear: "DISCOVERY_SEED_KNITWEAR",
  shoes: "DISCOVERY_SEED_SHOES",
  watches: "DISCOVERY_SEED_WATCHES",
  accessories: "DISCOVERY_SEED_ACCESSORIES",
  other: "DISCOVERY_SEED_OTHER",
};

function intEnv(name, def, min, max) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return def;
  const n = parseInt(String(raw), 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const FETCH_TIMEOUT_MS = intEnv("DISCOVERY_FETCH_TIMEOUT_MS", 18000, 1000, 120000);
const MAX_HTML_FETCHES = intEnv("DISCOVERY_MAX_PAGE_FETCHES", 28, 1, 60);
/** Full Chrome UA — many shops block or strip content for self-identified bots. */
const USER_AGENT =
  process.env.DISCOVERY_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let warnedNoSeeds = false;
let warnedWebDisabled = false;
let warnedWebSourcesOff = false;
let warnedNicheNoSeeds = false;

function splitSeedLine(raw) {
  return String(raw || "")
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((u) => /^https?:\/\//i.test(u));
}

function parseSeedUrls() {
  return splitSeedLine(process.env.DISCOVERY_SEED_URLS || "");
}

function seedsForCategory(categoryId) {
  const envName = CATEGORY_SEED_ENV[normalizeCategoryId(categoryId)];
  if (!envName) return [];
  return splitSeedLine(process.env[envName]);
}

/**
 * All unique https seeds: DISCOVERY_SEED_URLS plus every DISCOVERY_SEED_<CATEGORY>.
 */
function mergeAllDiscoverySeeds() {
  const seen = new Set();
  const out = [];
  function push(list) {
    for (const u of list) {
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
  }
  push(parseSeedUrls());
  for (const envName of Object.values(CATEGORY_SEED_ENV)) {
    push(splitSeedLine(process.env[envName]));
  }
  return out;
}

/**
 * @param {{ chatMode?: boolean, categoryIntent?: string | null }} [options]
 */
function resolveDiscoverySeeds(options = {}) {
  const { chatMode = false, categoryIntent = null, storeConfig = null } = options;
  const cat = categoryIntent ? normalizeCategoryId(categoryIntent) : null;
  const merged = mergeAllDiscoverySeeds();
  const cfgExtra = webSeedUrlsFromConfig(storeConfig, cat);
  const queryPack = generateCategoryQueryPack({
    storeConfig,
    categoryIntent: cat,
    chatSearchHint: options.chatSearchHint || "",
  });
  function uniqPush(target, list) {
    const seen = new Set(target);
    const out = [...target];
    for (const u of list || []) {
      const s = String(u || "").trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  if (chatMode) {
    /** Når brugeren har kategori-intent (fx sko), brug kun DISCOVERY_SEED_<KAT> — ikke SOURCING_CHAT_SEED_URL (undgår altid samme retail-side). */
    if (queryPack.categories.length) {
      let catSeeds = [];
      for (const cid of queryPack.categories.slice(0, 3)) {
        catSeeds = uniqPush(catSeeds, seedsForCategory(cid));
        catSeeds = uniqPush(catSeeds, webSeedUrlsFromConfig(storeConfig, cid));
      }
      catSeeds = uniqPush(catSeeds, cfgExtra);
      if (catSeeds.length) return catSeeds;
    }
    const single = String(process.env.SOURCING_CHAT_SEED_URL || "").trim();
    if (/^https?:\/\//i.test(single)) return uniqPush([single], cfgExtra);
    if (merged.length) return uniqPush([merged[0]], cfgExtra);
    return [...cfgExtra];
  }

  const allowedCats = Array.isArray(storeConfig && storeConfig.allowedCategories)
    ? [...new Set(storeConfig.allowedCategories.map((x) => normalizeCategoryId(x)).filter(Boolean))]
    : [];

  /**
   * Automation (ikke chat): når butikken har valgt niche-kategorier, crawles kun seeds der matcher
   * disse kategorier (+ DISCOVERY_SEED_URLS + tenant web-seeds pr. kategori). Undgår irrelevant crawl.
   */
  if (allowedCats.length) {
    let nicheSeeds = [];
    nicheSeeds = uniqPush(nicheSeeds, parseSeedUrls());
    nicheSeeds = uniqPush(nicheSeeds, webSeedUrlsFromConfig(storeConfig, null));
    const rankedCats = queryPack.categories.length ? queryPack.categories : allowedCats;
    for (const ac of rankedCats) {
      if (!ac || ac === "other") continue;
      nicheSeeds = uniqPush(nicheSeeds, seedsForCategory(ac));
      nicheSeeds = uniqPush(nicheSeeds, webSeedUrlsFromConfig(storeConfig, ac));
    }
    if (nicheSeeds.length) return nicheSeeds;
    if (!warnedNicheNoSeeds) {
      console.warn(
        "[discovery] allowedCategories er sat, men ingen seeds for disse kategorier — falder tilbage til fuld seed-liste (sæt DISCOVERY_SEED_* og/eller web.seedsByCategory)."
      );
      warnedNicheNoSeeds = true;
    }
  }

  if (cat && cat !== "other") {
    const catSeeds = uniqPush(seedsForCategory(cat), cfgExtra);
    if (catSeeds.length) return catSeeds;
  }

  return uniqPush([...merged], cfgExtra);
}

function sameHost(a, b) {
  try {
    return new URL(a).hostname.replace(/^www\./i, "") === new URL(b).hostname.replace(/^www\./i, "");
  } catch {
    return false;
  }
}

function absolutize(href, base) {
  try {
    return new URL(href, base).href.split("#")[0];
  } catch {
    return null;
  }
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "Web";
  }
}

function stableIdFromUrl(url) {
  try {
    const u = new URL(url);
    const p = u.pathname + u.search;
    if (p.length > 4) return `web:${u.hostname}${p}`.slice(0, 240);
    return `web:${u.href}`.slice(0, 240);
  } catch {
    return `web:${String(url).slice(0, 200)}`;
  }
}

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
    headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,da;q=0.8",
    },
      redirect: "follow",
  });
  if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLdBlocks(html) {
  const $ = cheerio.load(html);
  const blocks = [];
  $('script[type="application/ld+json"], script[type="application/ld+json; charset=utf-8"]').each((_, el) => {
    const txt = $(el).text().trim();
    if (!txt) return;
    try {
      blocks.push(JSON.parse(txt));
    } catch {
      /* invalid JSON-LD */
    }
  });
  return blocks;
}

function walkCollectProducts(node, out) {
  if (node == null) return;
  if (Array.isArray(node)) {
    node.forEach((n) => walkCollectProducts(n, out));
    return;
  }
  if (typeof node !== "object") return;

  const t = node["@type"];
  const types = Array.isArray(t) ? t : t != null ? [t] : [];
  const isProduct = types.some((x) => {
    const s = String(x).toLowerCase();
    return (
      s === "product" ||
      s === "https://schema.org/product" ||
      s.endsWith("/product") ||
      x === "Product" ||
      x === "https://schema.org/Product" ||
      String(x).endsWith("/Product")
    );
  });
  if (isProduct) out.push(node);

  if (node["@graph"]) walkCollectProducts(node["@graph"], out);
  for (const k of Object.keys(node)) {
    if (k === "@context" || k === "@type") continue;
    const v = node[k];
    if (v && typeof v === "object") walkCollectProducts(v, out);
  }
}

function walkCollectItemListLinks(node, out) {
  if (node == null) return;
  if (Array.isArray(node)) {
    node.forEach((n) => walkCollectItemListLinks(n, out));
    return;
  }
  if (typeof node !== "object") return;

  const t = node["@type"];
  const types = Array.isArray(t) ? t : t != null ? [t] : [];
  const isList = types.some((x) => x === "ItemList" || String(x).includes("ItemList"));
  if (isList && Array.isArray(node.itemListElement)) {
    for (const el of node.itemListElement) {
      const it = el && typeof el === "object" ? el.item || el : el;
      if (typeof it === "string" && /^https?:\/\//i.test(it)) out.push(it);
      else if (it && typeof it === "object") {
        if (it.url) out.push(it.url);
        else if (typeof it["@id"] === "string" && /^https?:\/\//i.test(it["@id"])) out.push(it["@id"]);
      }
    }
  }

  if (node["@graph"]) walkCollectItemListLinks(node["@graph"], out);
  for (const k of Object.keys(node)) {
    if (k === "@context" || k === "@type") continue;
    const v = node[k];
    if (v && typeof v === "object") walkCollectItemListLinks(v, out);
  }
}

function firstImage(img) {
  if (!img) return "";
  if (typeof img === "string") return img;
  if (Array.isArray(img)) {
    for (const x of img) {
      const u = firstImage(x);
      if (u) return u;
    }
    return "";
  }
  if (typeof img === "object" && img.url) return String(img.url);
  return "";
}

function allImages(img) {
  if (!img) return [];
  if (typeof img === "string") return [img];
  if (Array.isArray(img)) {
    const out = [];
    for (const x of img) out.push(...allImages(x));
    return out;
  }
  if (typeof img === "object") {
    if (img.url) return [String(img.url)];
    if (img.imageUrl) return [String(img.imageUrl)];
  }
  return [];
}

function offersPriceAndCurrency(offers) {
  if (offers == null) return { price: 0, currency: "" };
  const list = Array.isArray(offers) ? offers : [offers];
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const offerCur = String(o.priceCurrency || o.pricecurrency || "").trim();
    if (o.price != null) {
      const n = Number(String(o.price).replace(/[^\d.]/g, ""));
      if (!Number.isNaN(n) && n > 0) return { price: n, currency: offerCur };
    }
    const ps = o.priceSpecification;
    if (ps) {
      const pss = Array.isArray(ps) ? ps : [ps];
      for (const p of pss) {
        if (p && p.price != null) {
          const n = Number(String(p.price).replace(/[^\d.]/g, ""));
          if (!Number.isNaN(n) && n > 0) {
            const pCur = String(p.priceCurrency || "").trim();
            return { price: n, currency: pCur || offerCur };
          }
        }
      }
    }
  }
  return { price: 0, currency: "" };
}

function productUrl(obj, pageUrl) {
  const id = obj["@id"];
  if (typeof id === "string" && /^https?:\/\//i.test(id)) return id.split("#")[0];
  if (typeof obj.url === "string" && /^https?:\/\//i.test(obj.url)) return obj.url.split("#")[0];
  const offers = obj.offers;
  const o = Array.isArray(offers) ? offers[0] : offers;
  if (o && typeof o.url === "string" && /^https?:\/\//i.test(o.url)) return o.url.split("#")[0];
  return pageUrl;
}

function brandString(brand) {
  if (!brand) return "";
  if (typeof brand === "string") return brand;
  if (typeof brand === "object" && brand.name) return String(brand.name);
  return "";
}

function countryFromBrand(brand) {
  if (!brand || typeof brand !== "object") return "";
  const a = brand.address;
  if (!a) return "";
  const aa = Array.isArray(a) ? a[0] : a;
  if (aa && aa.addressCountry) return String(aa.addressCountry).slice(0, 80);
  return "";
}

function productRowFromJsonLd(obj, pageUrl, seedUrl, siteNameMeta) {
  const title = String(obj.name || obj.title || "").trim();
  if (!title) return null;
  const sourceUrl = productUrl(obj, pageUrl);
  const { price: rawPrice, currency: offerCurrency } = offersPriceAndCurrency(obj.offers);
  const price = normalizeDiscoveredPriceToDkk(rawPrice, offerCurrency, sourceUrl);
  const rawImages = allImages(obj.image).map((u) => absolutize(u, sourceUrl) || u);
  const normalizedImages = normalizeImages(rawImages, absolutize(firstImage(obj.image), sourceUrl) || firstImage(obj.image));
  const image = normalizedImages[0] || "";
  const brand = brandString(obj.brand);
  const supplierCountry =
    countryFromBrand(typeof obj.brand === "object" ? obj.brand : null) ||
    (process.env.DISCOVERY_DEFAULT_SUPPLIER_COUNTRY || "").trim();

  const platform = hostLabel(seedUrl || pageUrl);
  const sourceName = (brand || siteNameMeta || platform).trim();
  const supplierName = (brand || sourceName).trim();

  const offerRows = Array.isArray(obj.offers) ? obj.offers : obj.offers ? [obj.offers] : [];
  const variants = normalizeVariants(
    offerRows.map((o) => ({
      size: o && (o.size || o.name || o.sku) ? String(o.size || o.name || o.sku).slice(0, 50) : null,
      color: inferProductColor(title),
      price: Number(o && o.price) || price,
      available: String((o && o.availability) || "").toLowerCase().includes("outofstock") ? false : true,
    })),
    { size: "unknown", color: inferProductColor(title), price, available: true }
  );
  return {
    title,
    price,
    image: image || "",
    externalId: stableIdFromUrl(sourceUrl),
    category: inferCategory(title),
    color: inferProductColor(title),
    sourcePlatform: platform,
    sourceName,
    sourceUrl,
    sourceProductId: stableIdFromUrl(sourceUrl).slice(0, 200),
    supplierName,
    supplierCountry,
    importMethod: "scrape",
    sourceQuery: `seed ${hostLabel(seedUrl || pageUrl)}`,
    discovery_selection_mode: "exploit",
    discovery_query_confidence: "high",
    images: normalizedImages,
    variants,
    available: variants.some((v) => v.available !== false),
  };
}

function isNoisePath(path) {
  return /\/(cart|checkout|basket|login|signin|account|stores?|help|legal|privacy|contact|newsletter|wishlist)\b/i.test(
    path
  );
}

function looksLikeProductUrl(url) {
  try {
    const path = new URL(url).pathname;
    const pl = path.toLowerCase();
    if (isNoisePath(pl)) return false;
    if (/\/product\//i.test(path) || /\/products\//i.test(path)) return true;
    if (/\/collections\/[^/]+\/products\//i.test(path)) return true;
    if (/\/[a-z0-9][a-z0-9_-]*\/[A-Z]?\d{4,}\.html?$/i.test(path)) return true;
    const depth = path.split("/").filter(Boolean).length;
    if (/\.html?$/i.test(path) && depth >= 5) return true;
    return false;
  } catch {
    return false;
  }
}

function extractProductLinksFromHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const out = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) return;
    const abs = absolutize(href, baseUrl);
    if (!abs || !sameHost(abs, baseUrl)) return;
    const path = new URL(abs).pathname;
    const pl = path.toLowerCase();
    if (isNoisePath(pl)) return;
    if (
      /\/(product|products|p|item|items|shop)\b/i.test(pl) ||
      /\/collections\/[^/]+\/products(?:\/|$)/i.test(pl) ||
      /\/[a-z0-9-]{8,}\/?$/i.test(pl) ||
      looksLikeProductUrl(abs)
    ) {
      out.push(abs);
    }
  });
  return [...new Set(out)].slice(0, 48);
}

function extractOgTitle(html) {
  const $ = cheerio.load(html);
  const raw =
    $('meta[property="og:title"]').attr("content") ||
    $('meta[name="twitter:title"]').attr("content") ||
    $("title").first().text() ||
    "";
  const t = String(raw)
    .trim()
    .replace(/\s+/g, " ");
  if (!t || t.length < 3) return "";
  const first = t.split(/\s*[|\u2013\u2014-]\s*/)[0].trim();
  if (first.length >= 3 && first.length < 200) return first;
  return t.slice(0, 200);
}

/** When JSON-LD has no Product (common on React storefronts), use OG + meta price. */
function productRowFromOpenGraph(html, pageUrl, seedUrl) {
  const title = extractOgTitle(html);
  if (!title) return null;
  const image = extractOgImage(html, pageUrl);
  const images = normalizeImages([image], image);
  const { price: rawP, currency: ogCur } = extractOgPriceAndCurrency(html);
  const price = normalizeDiscoveredPriceToDkk(rawP, ogCur, pageUrl);
  if (price <= 0 || !String(image || "").trim()) return null;
  const siteNameMeta = extractOgSiteName(html);
  const platform = hostLabel(seedUrl || pageUrl);
  const sourceName = (siteNameMeta || platform).trim();
  const variants = normalizeVariants(
    [{ size: "unknown", color: inferProductColor(title), price, available: true }],
    { size: "unknown", color: inferProductColor(title), price, available: true }
  );
  return {
    title,
    price,
    image: images[0] || image,
    externalId: stableIdFromUrl(pageUrl),
    category: inferCategory(title),
    color: inferProductColor(title),
    sourcePlatform: platform,
    sourceName,
    sourceUrl: pageUrl.split("#")[0],
    sourceProductId: stableIdFromUrl(pageUrl).slice(0, 200),
    supplierName: sourceName,
    supplierCountry: (process.env.DISCOVERY_DEFAULT_SUPPLIER_COUNTRY || "").trim(),
    importMethod: "scrape",
    sourceQuery: `seed ${hostLabel(seedUrl || pageUrl)}`,
    discovery_selection_mode: "exploit",
    discovery_query_confidence: "high",
    images,
    variants,
    available: true,
  };
}

function extractOgImage(html, baseUrl) {
  const $ = cheerio.load(html);
  const c =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    $('meta[property="twitter:image"]').attr("content");
  return c ? absolutize(c.trim(), baseUrl) : "";
}

function extractOgSiteName(html) {
  const $ = cheerio.load(html);
  return ($('meta[property="og:site_name"]').attr("content") || "").trim();
}

function extractOgPriceAndCurrency(html) {
  const $ = cheerio.load(html);
  const p =
    $('meta[property="product:price:amount"]').attr("content") ||
    $('meta[property="og:price:amount"]').attr("content");
  const cur =
    $('meta[property="product:price:currency"]').attr("content") ||
    $('meta[property="og:price:currency"]').attr("content") ||
    $('meta[property="product:price:currency"]').attr("value") ||
    "";
  if (!p) return { price: 0, currency: String(cur || "").trim() };
  const n = Number(String(p).replace(/[^\d.]/g, ""));
  return { price: Number.isNaN(n) ? 0 : n, currency: String(cur || "").trim() };
}

function collectFromPage(html, pageUrl, seedUrl, storeConfig = null) {
  const products = [];
  const linkCandidates = [];
  const siteNameMeta = extractOgSiteName(html);
  const blocks = parseJsonLdBlocks(html);
  for (const block of blocks) {
    const found = [];
    walkCollectProducts(block, found);
    for (const p of found) {
      const row = productRowFromJsonLd(p, pageUrl, seedUrl, siteNameMeta);
      if (row) {
        if (titleFailsVeldenBrief(row.title, storeConfig)) {
          console.log("DISCOVERY REJECT:", {
            reason: "titleFailsVeldenBrief",
            title: String(row.title || "").slice(0, 140),
            sourceUrl: String(pageUrl || ""),
          });
          continue;
        }
        if (!row.image) {
          const og = extractOgImage(html, pageUrl);
          if (og) row.image = og;
        }
        if (row.price <= 0) {
          const og = extractOgPriceAndCurrency(html);
          if (og.price > 0) {
            row.price = normalizeDiscoveredPriceToDkk(og.price, og.currency, pageUrl);
          }
        }
        products.push(row);
      }
    }
    walkCollectItemListLinks(block, linkCandidates);
  }

  if (!products.length && looksLikeProductUrl(pageUrl)) {
    const ogRow = productRowFromOpenGraph(html, pageUrl, seedUrl);
    if (ogRow && !titleFailsVeldenBrief(ogRow.title, storeConfig)) products.push(ogRow);
    else if (ogRow) {
      console.log("DISCOVERY REJECT:", {
        reason: "titleFailsVeldenBrief",
        title: String(ogRow.title || "").slice(0, 140),
        sourceUrl: String(pageUrl || ""),
      });
    }
  }

  return { products, itemListLinks: [...new Set(linkCandidates)] };
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Automatisk import (CEO/sourcing-interval) — chat og engangs-scripts kan bruge ignoreAutoImportOff. */
function automaticImportDisabled(storeConfig, options) {
  if (options.chatMode || options.ignoreAutoImportOff) return false;
  return Boolean(storeConfig && storeConfig.autoProductImport === false);
}

function splitDiscoveryQuotas(total, web, shopify, ebay, amazon, aliexpress) {
  const parts = [];
  if (web) parts.push("web");
  if (shopify) parts.push("shopify");
  if (ebay) parts.push("ebay");
  if (amazon) parts.push("amazon");
  if (aliexpress) parts.push("aliexpress");
  if (!parts.length) return { web: 0, shopify: 0, ebay: 0, amazon: 0, aliexpress: 0 };
  const base = Math.floor(total / parts.length);
  let extra = total - base * parts.length;
  const o = { web: 0, shopify: 0, ebay: 0, amazon: 0, aliexpress: 0 };
  for (const p of parts) {
    o[p] = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
  }
  return o;
}

function pushDiscoveryCandidate(out, seenOut, r, desiredCount) {
  if (out.length >= desiredCount) return;
  const key = r.externalId || r.sourceUrl;
  if (!key || seenOut.has(key)) return;
  seenOut.add(key);
  out.push({
    ...r,
    category: r.category || inferCategory(r.title),
    color: r.color || inferProductColor(r.title),
  });
}

function pushDiscoveryCandidateWithFilters(out, seenOut, r, desiredCount, filterCtx) {
  const { stats, rejected, lowConfidenceBuffer, blockedKeywords, allowedCategories, queryMap, categoryMap } = filterCtx;
  stats.raw_candidates += 1;
  if (!r || typeof r !== "object") {
    stats.dropped_invalid += 1;
    return;
  }

  lowConfidenceBuffer.push({ ...r, discovery_confidence: "low", discovery_reason: "low_confidence_discovery" });

  const key = r.externalId || r.sourceUrl;
  if (!key || seenOut.has(key)) {
    stats.dropped_invalid += 1;
    return;
  }
  stats.after_seed_filter += 1;

  const title = String(r.title || "").toLowerCase();
  if (blockedKeywords.length && blockedKeywords.some((kw) => title.includes(kw))) {
    stats.dropped_keyword += 1;
    if (rejected.length < 80) rejected.push({ reason: "blocked_keyword", title: String(r.title || "").slice(0, 120) });
    return;
  }
  stats.after_keyword_filter += 1;

  const normCategory = normalizeCategoryId(r.category || inferCategory(r.title));
  if (allowedCategories.size > 0 && !allowedCategories.has(normCategory)) {
    stats.dropped_category += 1;
    if (rejected.length < 80) {
      rejected.push({
        reason: "category_allowlist",
        category: normCategory,
        title: String(r.title || "").slice(0, 120),
      });
    }
    return;
  }
  stats.after_category_filter += 1;

  const scored = computeDiscoveryScore(r, { queryMap, categoryMap });
  pushDiscoveryCandidate(out, seenOut, { ...r, ...scored }, desiredCount);
}

/**
 * @param {number} desiredCount
 * @param {{ chatMode?: boolean, categoryIntent?: string | null, chatSearchHint?: string, chatSeedRotateIndex?: number, storeConfig?: object | null, runId?: string | null, cycleId?: string | null, ignoreAutoImportOff?: boolean, discoveryLog?: null | ((action: string, payload: object) => void | Promise<void>) }} [options] — chatSearchHint: brugerens besked til eBay-søgning i chat; discoveryLog: ai_log via caller
 * @returns {Promise<Array<object>>}
 */
async function discoverProductsDetailed(desiredCount = 6, options = {}) {
  const storeConfig = options.storeConfig || null;
  const discoveryLog = typeof options.discoveryLog === "function" ? options.discoveryLog : null;
  const providerBreakdown = { web: 0, shopify: 0, ebay: 0, amazon: 0, aliexpress: 0 };
  const filterStats = {
    raw_candidates: 0,
    after_seed_filter: 0,
    after_keyword_filter: 0,
    after_category_filter: 0,
    final_candidates: 0,
    dropped_invalid: 0,
    dropped_keyword: 0,
    dropped_category: 0,
  };
  const rejectedSamples = [];
  const lowConfidencePool = [];
  const responseMeta = {
    providerBreakdown,
    counts: {
      requested: Math.max(0, Number(desiredCount) || 0),
      discovered: 0,
      activeProviders: 0,
      raw: 0,
      after_filter: 0,
      drop_rate: 0,
    },
    filterStats,
    rejectedSamples,
  };
  const finish = (status, reason, candidates) => ({
    status,
    reason: reason || null,
    meta: {
      ...responseMeta,
      counts: {
        ...responseMeta.counts,
        discovered: Array.isArray(candidates) ? candidates.length : 0,
        raw: filterStats.raw_candidates,
        after_filter: Array.isArray(candidates) ? candidates.length : 0,
        drop_rate:
          filterStats.raw_candidates > 0
            ? Number((1 - (Array.isArray(candidates) ? candidates.length : 0) / filterStats.raw_candidates).toFixed(4))
            : 0,
      },
    },
    candidates: Array.isArray(candidates) ? candidates : [],
  });
  console.log("STEP:", "discovery.start", {
    count: Math.max(0, Number(desiredCount) || 0),
    status: "running",
    reason: null,
  });
  if (discoveryLog && options.runId) {
    await discoveryLog("sourcing_run_started", {
      runId: options.runId,
      cycleId: options.cycleId ?? null,
      meta: {
        runId: options.runId,
        enabledSources: Array.isArray(storeConfig?.enabledSources) ? storeConfig.enabledSources : [],
        allowedCategories: Array.isArray(storeConfig?.allowedCategories) ? storeConfig.allowedCategories : [],
      },
    });
  }

  if ((Number(desiredCount) || 0) <= 0) {
    console.log("STEP:", "discovery.request.invalid", { count: 0, status: "no_results", reason: "at_capacity" });
    return finish("no_results", "at_capacity", []);
  }

  if (automaticImportDisabled(storeConfig, options)) {
    console.log("STEP:", "discovery.blocked.auto_import_disabled", { count: 0, status: "no_results", reason: "auto_import_disabled" });
    return finish("no_results", "auto_import_disabled", []);
  }

  const webProviderOn = storeConfig == null || isWebDiscoveryEnabled(storeConfig);
  const webSourcesOn = storeConfig == null || enabledSourcesAllowWebScrape(storeConfig);
  const webOn = webProviderOn && webSourcesOn;

  const shopifyActive = Boolean(storeConfig && isShopifySourcingActive(storeConfig));
  const ebayActive = Boolean(storeConfig && isEbaySourcingActive(storeConfig));
  const amazonActive = Boolean(storeConfig && isAmazonSourcingActive(storeConfig));
  const aliexpressActive = Boolean(storeConfig && isAliExpressSourcingActive(storeConfig));

  const activeSourceCount =
    (webOn ? 1 : 0) +
    (shopifyActive ? 1 : 0) +
    (ebayActive ? 1 : 0) +
    (amazonActive ? 1 : 0) +
    (aliexpressActive ? 1 : 0);
  responseMeta.counts.activeProviders = activeSourceCount;
  if (activeSourceCount <= 0) {
    console.log("STEP:", "discovery.blocked.providers_off", { count: 0, status: "no_results", reason: "provider_off" });
    return finish("no_results", "provider_off", []);
  }
  /** Også i sourcing-chat: fordel pladser så Shopify/eBay ikke overses når web fylder let. */
  const multiSplit = Boolean(activeSourceCount > 1);
  const queryMap = queryPerformanceMap(storeConfig);
  const categoryMap = categoryPerformanceMap(storeConfig);
  const allowedCategories = new Set(
    Array.isArray(storeConfig && storeConfig.allowedCategories)
      ? storeConfig.allowedCategories.map((c) => normalizeCategoryId(c)).filter(Boolean)
      : []
  );
  const blockedKeywords = Array.isArray(storeConfig && storeConfig.blockedKeywords)
    ? storeConfig.blockedKeywords
        .map((k) => String(k || "").trim().toLowerCase())
        .filter((k) => k.length >= 4)
    : [];
  const relaxedCategoryMode = allowedCategories.size > 0;
  const relaxedKeywordMode = blockedKeywords.length > 8;
  const effectiveBlockedKeywords = relaxedKeywordMode ? blockedKeywords.slice(0, 8) : blockedKeywords;
  const effectiveAllowedCategories = relaxedCategoryMode ? new Set() : allowedCategories;
  const quotas = splitDiscoveryQuotas(
    desiredCount,
    webOn,
    shopifyActive,
    ebayActive,
    amazonActive,
    aliexpressActive
  );

  const collected = [];
  let selectedWebSeeds = [];
  if (webOn && (!multiSplit || quotas.web > 0)) {
    let seeds = resolveDiscoverySeeds({
      chatMode: options.chatMode,
      categoryIntent: options.categoryIntent,
      chatSearchHint: options.chatSearchHint,
      storeConfig,
    });
    selectedWebSeeds = [...seeds];
    if (!seeds.length) {
      if (!warnedNoSeeds) {
        console.warn(
          "[discovery] No seed URLs — set DISCOVERY_SEED_URLS og/eller tenant web-seeds i store config (DISCOVERY_SEED_SHIRTS, …)."
        );
        warnedNoSeeds = true;
      }
    } else {
      if (options.chatMode && seeds.length > 1) {
        const rot = Number(options.chatSeedRotateIndex) || 0;
        const i = ((rot % seeds.length) + seeds.length) % seeds.length;
        seeds = [seeds[i]];
      }

      const webTarget = multiSplit ? quotas.web : Math.min(48, desiredCount + 10);
      const seenKeys = new Set();
      const queue = [];
      const enqueued = new Set();

      function enqueue(url, seedRoot, front = false) {
        const u = url.split("#")[0];
        if (!u || enqueued.has(u)) return;
        enqueued.add(u);
        const item = { url: u, seed: seedRoot || u };
        if (front) queue.unshift(item);
        else queue.push(item);
      }

      const seedOrder = [...seeds];
      if (!options.chatMode) shuffleInPlace(seedOrder);
      for (const s of seedOrder) enqueue(s, s);

      let fetches = 0;
      while (queue.length && collected.length < webTarget && fetches < MAX_HTML_FETCHES) {
        const { url: pageUrl, seed } = queue.shift();
        fetches += 1;
        const html = await fetchHtml(pageUrl);
        if (!html) continue;

        const { products, itemListLinks } = collectFromPage(html, pageUrl, seed);
        for (const row of products) {
          const k = row.sourceUrl || row.externalId;
          if (!k || seenKeys.has(k)) continue;
          if (row.price <= 0 || !String(row.image || "").trim()) continue;
          seenKeys.add(k);
          collected.push(row);
          providerBreakdown.web += 1;
          if (collected.length >= webTarget) break;
        }

        for (const link of itemListLinks) {
          const abs = absolutize(link, pageUrl);
          if (abs && sameHost(abs, seed)) enqueue(abs, seed, looksLikeProductUrl(abs));
        }

        for (const link of extractProductLinksFromHtml(html, pageUrl)) {
          if (sameHost(link, seed)) enqueue(link, seed, looksLikeProductUrl(link));
        }
      }
      if (collected.length) {
        const rankedCollected = sortCandidatesByDiscoveryScore(collected, storeConfig);
        collected.length = 0;
        collected.push(...rankedCollected);
      }
    }
  } else if (!webOn) {
    if (!webProviderOn && !warnedWebDisabled) {
      console.warn("[discovery] Web discovery er slået fra i store config (sourcing.providers.web.enabled).");
      warnedWebDisabled = true;
    } else if (!webSourcesOn && !warnedWebSourcesOff) {
      console.warn(
        '[discovery] Web crawl er fravalgt i enabledSources (tilføj fx «web» under kilder for HTTP-discovery).'
      );
      warnedWebSourcesOff = true;
    }
  }

  const out = [];
  const seenOut = new Set();
  const filterCtx = {
    stats: filterStats,
    rejected: rejectedSamples,
    lowConfidenceBuffer: lowConfidencePool,
    blockedKeywords: effectiveBlockedKeywords,
    allowedCategories: effectiveAllowedCategories,
    queryMap,
    categoryMap,
  };

  if (!multiSplit) {
    for (const r of collected) {
      pushDiscoveryCandidateWithFilters(out, seenOut, r, desiredCount, filterCtx);
    }
  } else {
    const n = Math.min(collected.length, quotas.web);
    for (let i = 0; i < n; i++) {
      pushDiscoveryCandidateWithFilters(out, seenOut, collected[i], desiredCount, filterCtx);
    }
  }

  const webGot = multiSplit ? Math.min(collected.length, quotas.web) : Math.min(collected.length, desiredCount);

  const afterWeb = out.length;
  if (shopifyActive && out.length < desiredCount) {
    const fetchMultiplier = filterStats.raw_candidates > 0 && out.length === 0 ? 3 : 2;
    const shopTake = multiSplit
      ? Math.min((desiredCount - out.length) * fetchMultiplier, (quotas.shopify + Math.max(0, quotas.web - webGot)) * fetchMultiplier)
      : (desiredCount - out.length) * fetchMultiplier;
    const fromShopify = sortCandidatesByDiscoveryScore(
      await fetchShopifyProductCandidates(shopTake, { ...options, storeConfig }),
      storeConfig
    );
    for (const r of fromShopify) {
      pushDiscoveryCandidateWithFilters(out, seenOut, r, desiredCount, filterCtx);
    }
    providerBreakdown.shopify += Math.max(0, Math.min(desiredCount, fromShopify.length));
  }

  const shopGot = out.length - afterWeb;

  if (ebayActive && out.length < desiredCount) {
    const fetchMultiplier = filterStats.raw_candidates > 0 && out.length === 0 ? 3 : 2;
    const ebayTake = multiSplit
      ? Math.min((desiredCount - out.length) * fetchMultiplier, (quotas.ebay + Math.max(0, quotas.shopify - shopGot)) * fetchMultiplier)
      : (desiredCount - out.length) * fetchMultiplier;
    const fromEbay = sortCandidatesByDiscoveryScore(
      await fetchEbayProductCandidates(ebayTake, {
        ...options,
        storeConfig,
        discoveryLog,
        runId: options.runId || null,
        cycleId: options.cycleId || null,
      }),
      storeConfig
    );
    for (const r of fromEbay) {
      pushDiscoveryCandidateWithFilters(out, seenOut, r, desiredCount, filterCtx);
    }
    providerBreakdown.ebay += Math.max(0, Math.min(desiredCount, fromEbay.length));
  }

  const ebayGot = out.length - afterWeb - shopGot;

  if (amazonActive && out.length < desiredCount) {
    const fetchMultiplier = filterStats.raw_candidates > 0 && out.length === 0 ? 3 : 2;
    const amazonTake = multiSplit
      ? Math.min((desiredCount - out.length) * fetchMultiplier, (quotas.amazon + Math.max(0, quotas.ebay - ebayGot)) * fetchMultiplier)
      : (desiredCount - out.length) * fetchMultiplier;
    const fromAmazon = sortCandidatesByDiscoveryScore(
      await fetchAmazonProductCandidates(amazonTake, {
        ...options,
        storeConfig,
      }),
      storeConfig
    );
    for (const r of fromAmazon) {
      pushDiscoveryCandidateWithFilters(out, seenOut, r, desiredCount, filterCtx);
    }
    providerBreakdown.amazon += Math.max(0, Math.min(desiredCount, fromAmazon.length));
  }

  if (aliexpressActive && out.length < desiredCount) {
    const fetchMultiplier = filterStats.raw_candidates > 0 && out.length === 0 ? 3 : 2;
    const aliTake = multiSplit
      ? Math.min((desiredCount - out.length) * fetchMultiplier, quotas.aliexpress * fetchMultiplier)
      : (desiredCount - out.length) * fetchMultiplier;
    const fromAli = sortCandidatesByDiscoveryScore(
      await fetchAliExpressProductCandidates(aliTake, {
        ...options,
        storeConfig,
      }),
      storeConfig
    );
    for (const r of fromAli) {
      pushDiscoveryCandidateWithFilters(out, seenOut, r, desiredCount, filterCtx);
    }
    providerBreakdown.aliexpress += Math.max(0, Math.min(desiredCount, fromAli.length));
  }

  filterStats.final_candidates = out.length;
  console.log("DISCOVERY STEP:", {
    raw_candidates: filterStats.raw_candidates,
    after_seed_filter: filterStats.after_seed_filter,
    after_keyword_filter: filterStats.after_keyword_filter,
    after_category_filter: filterStats.after_category_filter,
    final_candidates: filterStats.final_candidates,
  });

  if (out.length === 0 && filterStats.raw_candidates > 0 && lowConfidencePool.length > 0) {
    const topN = Math.max(1, Math.min(5, Number(desiredCount) || 1));
    const rescued = lowConfidencePool
      .filter((r) => Number(r.price) > 0 && String(r.image || "").trim())
      .sort((a, b) => Number(b.price || 0) - Number(a.price || 0))
      .slice(0, topN);
    for (const row of rescued) {
      pushDiscoveryCandidate(out, seenOut, row, desiredCount);
    }
  }

  if (rejectedSamples.length) {
    console.log("DISCOVERY REJECTED SAMPLE:", rejectedSamples.slice(0, 20));
  }
  try {
    await recordDiscoveredCandidates(options.supabase || null, out, {
      sourceQuery: options.chatSearchHint || "",
    });
  } catch (_) {
    // Discovery performance storage is optional runtime telemetry.
  }

  if (out.length === 0 && discoveryLog) {
    const rid = options.runId ?? null;
    const noSeedReason = webOn && selectedWebSeeds.length === 0 ? "no_seed" : "filtered_out";
    await discoveryLog("sourcing_no_candidates", {
      runId: rid,
      cycleId: options.cycleId ?? null,
      reason: noSeedReason,
      meta: {
        ...(rid ? { runId: rid } : {}),
        reasonCode: noSeedReason,
        enabledSources: Array.isArray(storeConfig?.enabledSources) ? storeConfig.enabledSources : [],
        allowedCategories: Array.isArray(storeConfig?.allowedCategories) ? storeConfig.allowedCategories : [],
        webEnabled: webOn,
        shopifyEnabled: Boolean(storeConfig && isShopifySourcingActive(storeConfig)),
        ebayBrowseEnabled: Boolean(storeConfig && isEbaySourcingActive(storeConfig)),
        amazonEnabled: Boolean(storeConfig && isAmazonSourcingActive(storeConfig)),
        aliexpressEnabled: Boolean(storeConfig && isAliExpressSourcingActive(storeConfig)),
        autoProductImport: storeConfig ? storeConfig.autoProductImport !== false : true,
      },
    });
  }

  if (discoveryLog) {
    const queryPack = generateCategoryQueryPack({
      storeConfig,
      categoryIntent: options.categoryIntent || null,
      chatSearchHint: options.chatSearchHint || "",
    });
    const explorationRate = Number(
      (storeConfig && storeConfig.discoveryExplorationRate) || process.env.DISCOVERY_EXPLORATION_RATE || 0.2
    );
    const confidenceMix = (queryPack.packs || []).reduce(
      (acc, p) => {
        for (const v of p.variants || []) {
          if (String(v.confidence || "low") === "high") acc.high += 1;
          else acc.low += 1;
        }
        return acc;
      },
      { high: 0, low: 0 }
    );
    responseMeta.exploration = {
      explorationRate: Number(Math.max(0.05, Math.min(0.6, explorationRate)).toFixed(4)),
      confidenceMix,
    };
    await discoveryLog("sourcing_query_plan", {
      runId: options.runId || null,
      cycleId: options.cycleId || null,
      source: "web_discovery",
      activeCategories: queryPack.debug.categories || [],
      categoryIntent: queryPack.debug.categoryIntent || null,
      generatedQueryTypes: (queryPack.packs || [])
        .flatMap((p) => (p.variants || []).map((v) => `${p.categoryId}:${v.type}`))
        .slice(0, 80),
      exploration: responseMeta.exploration,
      selectedSeeds: selectedWebSeeds.slice(0, 30),
      hintTokens: queryPack.debug.hintTokens || [],
    });
  }

  if (out.length === 0) {
    const noSeedReason = webOn && selectedWebSeeds.length === 0 ? "no_seed" : "filtered_out";
    console.log("STEP:", "discovery.complete", { count: 0, status: "no_results", reason: noSeedReason });
    return finish("no_results", noSeedReason, []);
  }
  console.log("STEP:", "discovery.complete", { count: out.length, status: "ok", reason: null });
  return finish("ok", null, out);
}

async function discoverProducts(desiredCount = 6, options = {}) {
  const detailed = await discoverProductsDetailed(desiredCount, options);
  return detailed.candidates;
}

module.exports = {
  discoverProducts,
  discoverProductsDetailed,
  mergeAllDiscoverySeeds,
  resolveDiscoverySeeds,
};
