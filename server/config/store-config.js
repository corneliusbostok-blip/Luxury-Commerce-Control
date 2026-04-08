const fs = require("fs");
const path = require("path");
const { z } = require("zod");
const { normalizeSourcingBlock, mergeSourcingPatch } = require("../services/sourcing/providers");
const { clearSourcingUserRejects } = require("../services/sourcing-memory");

const defaultPath = path.join(__dirname, "store-config.default.json");
const runtimePath = process.env.STORE_CONFIG_PATH
  ? path.resolve(process.env.STORE_CONFIG_PATH)
  : null;

function asFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function defaultIntegrations() {
  return {
    ebay: { clientId: "", clientSecret: "", oauthToken: "", devId: "" },
    alibaba: { appKey: "", appSecret: "", accessToken: "" },
  };
}

function normalizeIntegrations(raw) {
  const d = defaultIntegrations();
  if (!raw || typeof raw !== "object") return d;
  const ebay = { ...d.ebay, ...(raw.ebay && typeof raw.ebay === "object" ? raw.ebay : {}) };
  const alibaba = { ...d.alibaba, ...(raw.alibaba && typeof raw.alibaba === "object" ? raw.alibaba : {}) };
  for (const o of [ebay, alibaba]) {
    for (const k of Object.keys(o)) {
      o[k] = o[k] == null ? "" : String(o[k]);
    }
  }
  return { ebay, alibaba };
}

/**
 * Tom streng for hemmelige felter = behold eksisterende værdi (ved gem fra admin-UI).
 */
function mergeIntegrations(base, patch) {
  const b = normalizeIntegrations(base);
  if (!patch || typeof patch !== "object") return b;
  const out = { ebay: { ...b.ebay }, alibaba: { ...b.alibaba } };
  for (const plat of ["ebay", "alibaba"]) {
    const src = patch[plat];
    if (!src || typeof src !== "object") continue;
    const secrets = plat === "ebay" ? ["clientSecret", "oauthToken"] : ["appSecret", "accessToken"];
    for (const key of Object.keys(src)) {
      if (!(key in out[plat])) continue;
      const val = src[key];
      if (val === undefined || val === null) continue;
      const s = typeof val === "string" ? val.trim() : String(val);
      if (s === "" && secrets.includes(key)) continue;
      out[plat][key] = s;
    }
  }
  return out;
}

/** Til GET /api/admin/store-config — ingen hemmeligheder i JSON. */
function sanitizeStoreConfigForClient(cfg) {
  const c = cfg && typeof cfg === "object" ? { ...cfg } : {};
  const int = normalizeIntegrations(c.integrations);
  c.integrations = {
    ebay: {
      clientId: int.ebay.clientId,
      devId: int.ebay.devId,
      clientSecretSet: Boolean(int.ebay.clientSecret),
      oauthTokenSet: Boolean(int.ebay.oauthToken),
    },
    alibaba: {
      appKey: int.alibaba.appKey,
      appSecretSet: Boolean(int.alibaba.appSecret),
      accessTokenSet: Boolean(int.alibaba.accessToken),
    },
  };
  c.autoProductImport = c.autoProductImport !== false;
  const s = normalizeSourcingBlock(c.sourcing);
  c.sourcing = {
    defaultProvider: s.defaultProvider,
    merchandising: {
      focus: s.merchandising.focus,
      seasonNote: s.merchandising.seasonNote || "",
      vibeKeywords: s.merchandising.vibeKeywords || "",
    },
    providers: {
      web: {
        enabled: s.providers.web.enabled,
        seedUrls: s.providers.web.seedUrls || [],
        seedsByCategory: s.providers.web.seedsByCategory || {},
      },
      shopify: {
        enabled: s.providers.shopify.enabled,
        storeUrl: s.providers.shopify.storeUrl || "",
        collectionHandle: s.providers.shopify.collectionHandle || "",
        adminShopHost: s.providers.shopify.adminShopHost || "",
        accessTokenSet: Boolean(String(s.providers.shopify.accessToken || "").trim()),
      },
      ebay: {
        enabled: s.providers.ebay.enabled,
      },
      alibaba: { enabled: s.providers.alibaba.enabled },
      cjdropshipping: { enabled: s.providers.cjdropshipping.enabled },
    },
  };
  if (c.marketing && typeof c.marketing === "object") {
    const m = c.marketing;
    const platforms = m.platforms && typeof m.platforms === "object" ? m.platforms : {};
    const outPlatforms = {};
    for (const p of ["facebook", "instagram", "tiktok"]) {
      const row = platforms[p] && typeof platforms[p] === "object" ? platforms[p] : {};
      outPlatforms[p] = {
        enabled: row.enabled !== false,
        connected: Boolean(String(row.token || row.token_enc || "").trim()),
        pageId: row.pageId ? String(row.pageId) : "",
        igUserId: row.igUserId ? String(row.igUserId) : "",
        accountId: row.accountId ? String(row.accountId) : "",
        tokenSet: Boolean(String(row.token || row.token_enc || "").trim()),
      };
    }
    c.marketing = {
      enabled: m.enabled === true,
      settings: m.settings && typeof m.settings === "object" ? { ...m.settings } : {},
      platforms: outPlatforms,
      oauth_meta: m.oauth_meta && typeof m.oauth_meta === "object"
        ? {
            tiktok_expires_in: Number(m.oauth_meta.tiktok_expires_in) || null,
            updated_at: m.oauth_meta.updated_at || null,
            tiktok_refresh_token_set: Boolean(String(m.oauth_meta.tiktok_refresh_token || "").trim()),
          }
        : {},
      posts: Array.isArray(m.posts) ? m.posts.slice(0, 100) : [],
    };
  }
  return c;
}

function normalizeConfigShape(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const min = Math.max(0, asFiniteNumber(c.priceRange && c.priceRange.min, 0));
  const maxRaw = asFiniteNumber(c.priceRange && c.priceRange.max, Number.POSITIVE_INFINITY);
  const max = maxRaw >= min ? maxRaw : min;
  const targetMargin = Math.min(0.95, Math.max(0.05, asFiniteNumber(c.targetMargin, 0.55)));
  const strategy = c.strategy && typeof c.strategy === "object" ? c.strategy : {};
  const risk = String(strategy.risk || "balanced");
  const goal = String(strategy.goal || "maximize_profit");
  /** 0 = ingen grænse; ellers maks. godkendte/aktive katalogrækker før automation stopper import. */
  const maxCatalogRaw = asFiniteNumber(c.maxCatalogProducts, 0);
  const maxCatalogProducts =
    !Number.isFinite(maxCatalogRaw) || maxCatalogRaw <= 0
      ? 0
      : Math.min(50000, Math.max(1, Math.floor(maxCatalogRaw)));
  const queryRewriteMemory = Array.isArray(c.queryRewriteMemory)
    ? c.queryRewriteMemory
        .filter((x) => x && typeof x === "object")
        .map((x) => ({
          query: String(x.query || "").trim().toLowerCase(),
          suggestion: String(x.suggestion || "").trim(),
          score: Number(x.score) || 0,
          updatedAt: x.updatedAt ? String(x.updatedAt) : new Date().toISOString(),
        }))
        .filter((x) => x.query && x.suggestion)
        .slice(0, 200)
    : [];
  const queryPerformanceMemory = Array.isArray(c.queryPerformanceMemory)
    ? c.queryPerformanceMemory
        .filter((x) => x && typeof x === "object")
        .map((x) => ({
          query: String(x.query || "").trim().toLowerCase(),
          avg_profit: Number(x.avg_profit) || 0,
          conversion_rate: Number(x.conversion_rate) || 0,
          revenue_per_impression: Number(x.revenue_per_impression) || 0,
          score: Number(x.score) || 0,
          sample_size: Number(x.sample_size) || 0,
          tier: String(x.tier || "mid").trim() || "mid",
          updatedAt: x.updatedAt ? String(x.updatedAt) : new Date().toISOString(),
        }))
        .filter((x) => x.query)
        .slice(0, 120)
    : [];
  const categoryPerformanceMemory = Array.isArray(c.categoryPerformanceMemory)
    ? c.categoryPerformanceMemory
        .filter((x) => x && typeof x === "object")
        .map((x) => ({
          category: String(x.category || "").trim().toLowerCase(),
          profit_per_sku: Number(x.profit_per_sku) || 0,
          sales_velocity: Number(x.sales_velocity) || 0,
          avg_time_to_first_sale_hours:
            x.avg_time_to_first_sale_hours == null ? null : Number(x.avg_time_to_first_sale_hours) || null,
          score: Number(x.score) || 0,
          sample_size: Number(x.sample_size) || 0,
          updatedAt: x.updatedAt ? String(x.updatedAt) : new Date().toISOString(),
        }))
        .filter((x) => x.category)
        .slice(0, 80)
    : [];
  return {
    ...c,
    targetMargin,
    priceRange: { min, max },
    strategy: { ...strategy, goal, risk },
    maxCatalogProducts,
    autoProductImport: c.autoProductImport === false ? false : true,
    allowedCategories: Array.isArray(c.allowedCategories) ? c.allowedCategories.filter(Boolean) : [],
    blockedKeywords: Array.isArray(c.blockedKeywords) ? c.blockedKeywords.filter(Boolean) : [],
    enabledSources: Array.isArray(c.enabledSources) ? c.enabledSources.filter(Boolean) : [],
    /** Admin · valgt butikstype-dropdown (påvirker ikke serverlogik; genskabes i UI). */
    adminVerticalKey: String(c.adminVerticalKey || "").trim(),
    queryRewriteMemory,
    queryPerformanceMemory,
    categoryPerformanceMemory,
    integrations: normalizeIntegrations(c.integrations),
    sourcing: normalizeSourcingBlock(c.sourcing),
  };
}

function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function mergedConfig(base, patch) {
  const b = base || {};
  const p = patch || {};
  const {
    integrations: pInt,
    priceRange: pPrice,
    strategy: pStrat,
    allowedCategories: pAC,
    blockedKeywords: pBK,
    enabledSources: pES,
    sourcing: pSourcing,
    adminVerticalKey: pVK,
    ...pRest
  } = p;
  return {
    ...b,
    ...pRest,
    priceRange: { ...(b.priceRange || {}), ...(pPrice || {}) },
    strategy: { ...(b.strategy || {}), ...(pStrat || {}) },
    allowedCategories: Array.isArray(pAC) ? pAC : b.allowedCategories || [],
    blockedKeywords: Array.isArray(pBK) ? pBK : b.blockedKeywords || [],
    enabledSources: Array.isArray(pES) ? pES : b.enabledSources || [],
    adminVerticalKey: pVK !== undefined ? String(pVK || "").trim() : String(b.adminVerticalKey || "").trim(),
    integrations: mergeIntegrations(b.integrations, pInt !== undefined ? pInt : {}),
    sourcing: pSourcing !== undefined ? mergeSourcingPatch(b.sourcing, pSourcing) : normalizeSourcingBlock(b.sourcing),
  };
}

let memoryConfig = null;
const storeConfigPatchSchema = z.object({}).passthrough();

async function getStoreConfig(supabase) {
  const defaults = readJsonSafe(defaultPath) || {};
  const fileConfig = readJsonSafe(runtimePath) || {};
  let dbConfig = {};
  if (supabase) {
    try {
      const { data } = await supabase.from("store_config").select("config").eq("key", "active").maybeSingle();
      dbConfig = (data && data.config) || {};
    } catch {
      dbConfig = {};
    }
  }
  /* DB skal vinde over gammel memory — ellers ser sourcing ikke nye kategorier/kilder efter gem i dashboard. */
  const merged = normalizeConfigShape(mergedConfig(mergedConfig(defaults, fileConfig), dbConfig));
  memoryConfig = merged;
  return merged;
}

async function updateStoreConfig(supabase, patch) {
  if (!patch || typeof patch !== "object") {
    return { status: "error", reason: "invalid_patch", issues: [] };
  }
  const validation = storeConfigPatchSchema.safeParse(patch);
  if (!validation.success) {
    return {
      status: "error",
      reason: "invalid_config",
      issues: validation.error.issues || [],
    };
  }
  const safePatch = validation.data;
  if (!supabase) {
    const currentMem = memoryConfig || {};
    const nextMem = normalizeConfigShape(mergedConfig(currentMem, safePatch));
    memoryConfig = nextMem;
    return nextMem;
  }
  const maxAttempts = 4;
  let attempt = 0;
  let last = null;
  while (attempt < maxAttempts) {
    attempt += 1;
    const { data: row } = await supabase
      .from("store_config")
      .select("config,updated_at")
      .eq("key", "active")
      .maybeSingle();
    const current = normalizeConfigShape(row && row.config ? row.config : await getStoreConfig(supabase));
    const next = normalizeConfigShape(mergedConfig(current, safePatch));
    const prevVerticalKey = String(current.adminVerticalKey || "").trim();
    const nextVerticalKey = String(next.adminVerticalKey || "").trim();
    const nextUpdatedAt = new Date().toISOString();
    if (!row) {
      await supabase.from("store_config").upsert(
        { key: "active", config: next, updated_at: nextUpdatedAt },
        { onConflict: "key" }
      );
      memoryConfig = next;
      if (prevVerticalKey !== nextVerticalKey) await clearSourcingUserRejects(supabase);
      return next;
    }
    const prevUpdatedAt = row.updated_at;
    const { data: updatedRows, error } = await supabase
      .from("store_config")
      .update({ config: next, updated_at: nextUpdatedAt })
      .eq("key", "active")
      .eq("updated_at", prevUpdatedAt)
      .select("key");
    if (!error && Array.isArray(updatedRows) && updatedRows.length === 1) {
      memoryConfig = next;
      if (prevVerticalKey !== nextVerticalKey) await clearSourcingUserRejects(supabase);
      return next;
    }
    last = error || new Error("store_config_concurrent_write_conflict");
  }
  return {
    status: "error",
    reason: "write_conflict",
    issues: [{ message: (last && last.message) || "store_config_update_failed" }],
  };
}

module.exports = {
  getStoreConfig,
  updateStoreConfig,
  sanitizeStoreConfigForClient,
};
