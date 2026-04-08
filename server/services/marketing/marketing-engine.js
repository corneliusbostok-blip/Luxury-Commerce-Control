const crypto = require("crypto");
const logger = require("../../lib/logger");
const { getStoreConfig, updateStoreConfig } = require("../../config/store-config");
const { defaultMarketingProviders, providerByPlatform } = require("./providers/provider-registry");
const { generateMarketingContent } = require("./content-generator");
const { acquireLock, acquireLockAtomic, releaseLock, AtomicLockRpcError } = require("../automation-lock");
const {
  acquirePublishSlot,
  beginOutboundPublishWithRetry,
  isPublishDone,
  completePublishDurableWithRetry,
  PublishGuardRpcError,
} = require("./publish-guard");
const { resolvePublicUrl } = require("../../lib/public-url");

function publicBaseUrl() {
  return resolvePublicUrl();
}

function encKey() {
  const raw = String(process.env.MARKETING_TOKEN_ENC_KEY || "").trim();
  if (!raw) return null;
  const b = Buffer.from(raw, "base64");
  return b.length === 32 ? b : null;
}

function encryptToken(plain) {
  const key = encKey();
  const p = String(plain || "");
  if (!key || !p) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(p, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptToken(payload) {
  const key = encKey();
  const s = String(payload || "");
  if (!s) return "";
  if (!key) return s;
  try {
    const raw = Buffer.from(s, "base64");
    if (raw.length < 28) return "";
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return "";
  }
}

function normalizeMarketingConfig(cfg = {}) {
  const src = cfg && cfg.marketing && typeof cfg.marketing === "object" ? cfg.marketing : {};
  const platforms = src.platforms && typeof src.platforms === "object" ? src.platforms : {};
  const outPlatforms = {};
  for (const p of ["facebook", "instagram", "tiktok"]) {
    const row = platforms[p] && typeof platforms[p] === "object" ? platforms[p] : {};
    const decrypted = row.token_enc ? decryptToken(row.token_enc) : "";
    const token = decrypted || String(row.token || "");
    outPlatforms[p] = {
      token,
      token_enc: String(row.token_enc || ""),
      pageId: String(row.pageId || ""),
      igUserId: String(row.igUserId || ""),
      accountId: String(row.accountId || ""),
      authMethod: String(row.authMethod || ""),
      connectedAt: row.connectedAt ? String(row.connectedAt) : "",
      enabled: row.enabled !== false,
      connected: Boolean(String(token || row.token_enc || "").trim()),
    };
  }
  return {
    enabled: src.enabled === true,
    settings: {
      postOnNewProduct: src.settings ? src.settings.postOnNewProduct !== false : true,
      postOnPriceDrop: src.settings ? src.settings.postOnPriceDrop === true : false,
      postOnTrendingProduct: src.settings ? src.settings.postOnTrendingProduct === true : false,
      maxPostsPerDay: Math.max(1, Math.min(20, Number(src.settings && src.settings.maxPostsPerDay) || 3)),
    },
    platforms: outPlatforms,
    oauth_meta: src.oauth_meta && typeof src.oauth_meta === "object" ? { ...src.oauth_meta } : {},
    posts: Array.isArray(src.posts) ? src.posts.slice(0, 100) : [],
  };
}

async function getMarketingStatus(supabase) {
  const cfg = await getStoreConfig(supabase);
  const m = normalizeMarketingConfig(cfg);
  const providers = defaultMarketingProviders().map((p) => {
    const platform = p.platform();
    const row = (m.platforms && m.platforms[platform]) || {};
    return {
      platform,
      connected: p.isConnected(m),
      enabled: p.isEnabled(m),
      authMethod: row.authMethod || "",
      connectedAt: row.connectedAt || "",
    };
  });
  return { enabled: m.enabled, settings: m.settings, platforms: providers };
}

async function setMarketingConfig(supabase, patch) {
  const lockKey = "marketing:config";
  const lockTtlMs = 20_000;
  let hasLock = false;
  for (let i = 0; i < 6; i += 1) {
    hasLock = await acquireLock(supabase, lockKey, lockTtlMs);
    if (hasLock) break;
    await new Promise((r) => setTimeout(r, 120 + i * 80));
  }
  if (!hasLock) throw new Error("marketing_config_busy");
  try {
    const cfg = await getStoreConfig(supabase);
    const m = normalizeMarketingConfig(cfg);
    const next = {
      ...m,
      ...patch,
      platforms: patch && patch.platforms ? { ...m.platforms, ...patch.platforms } : m.platforms,
      settings: patch && patch.settings ? { ...m.settings, ...patch.settings } : m.settings,
    };
    // Never persist plaintext tokens in config.
    for (const p of ["facebook", "instagram", "tiktok"]) {
      const row = next.platforms && next.platforms[p] ? { ...next.platforms[p] } : {};
      const plain = String(row.token || "");
      if (plain && !row.token_enc) row.token_enc = encryptToken(plain) || plain;
      row.token = "";
      next.platforms[p] = row;
    }
    const saved = await updateStoreConfig(supabase, { marketing: next });
    if (saved && saved.status === "error") {
      throw new Error((saved.issues && saved.issues[0] && saved.issues[0].message) || saved.reason || "marketing_config_update_failed");
    }
    return normalizeMarketingConfig(saved);
  } finally {
    await releaseLock(supabase, lockKey);
  }
}

async function connectPlatform(supabase, platform, token, extra = {}) {
  const p = String(platform || "").toLowerCase();
  const t = String(token || "").trim();
  if (!["facebook", "instagram", "tiktok"].includes(p)) return { ok: false, error: "Unsupported platform" };
  const patch = {
    token: "",
    token_enc: encryptToken(t) || t,
    enabled: true,
    connected: Boolean(t),
    authMethod: String(extra.authMethod || "manual"),
    connectedAt: String(extra.connectedAt || new Date().toISOString()),
  };
  if (extra && extra.pageId) patch.pageId = String(extra.pageId).trim();
  if (extra && extra.igUserId) patch.igUserId = String(extra.igUserId).trim();
  if (extra && extra.accountId) patch.accountId = String(extra.accountId).trim();
  const withMeta = await setMarketingConfig(supabase, {
    platforms: {
      [p]: patch,
    },
  });
  return { ok: true, marketing: withMeta };
}

async function disconnectPlatform(supabase, platform) {
  const p = String(platform || "").toLowerCase();
  if (!["facebook", "instagram", "tiktok"].includes(p)) return { ok: false, error: "Unsupported platform" };
  const next = await setMarketingConfig(supabase, {
    platforms: {
      [p]: {
        token: "",
        token_enc: "",
        enabled: false,
        connected: false,
        pageId: "",
        igUserId: "",
        accountId: "",
        authMethod: "",
        connectedAt: "",
      },
    },
  });
  return { ok: true, marketing: next };
}

async function togglePlatform(supabase, platform, enabled) {
  const p = String(platform || "").toLowerCase();
  if (!["facebook", "instagram", "tiktok"].includes(p)) return { ok: false, error: "Unsupported platform" };
  const next = await setMarketingConfig(supabase, {
    platforms: {
      [p]: { enabled: Boolean(enabled) },
    },
  });
  return { ok: true, marketing: next };
}

async function updateMarketingSettings(supabase, settings = {}) {
  const next = await setMarketingConfig(supabase, { settings, enabled: settings.enabled === true });
  return { ok: true, marketing: next };
}

async function updateMarketingOauthMeta(supabase, patchMeta = {}) {
  const cfg = await getStoreConfig(supabase);
  const m = normalizeMarketingConfig(cfg);
  const cur = m.oauth_meta && typeof m.oauth_meta === "object" ? m.oauth_meta : {};
  const next = await setMarketingConfig(supabase, { oauth_meta: { ...cur, ...(patchMeta || {}) } });
  return { ok: true, marketing: next };
}

async function testPost(supabase, input = {}) {
  const cfg = await getStoreConfig(supabase);
  const m = normalizeMarketingConfig(cfg);
  const platform = String(input.platform || "facebook").toLowerCase();
  const provider = providerByPlatform(platform);
  if (!provider) return { ok: false, error: "Unsupported platform" };
  const picked = await pickProductForManualPost(supabase, input.productId || null);
  const productUrl =
    picked && picked.id ? `${publicBaseUrl()}/product.html?id=${encodeURIComponent(String(picked.id))}` : "";
  const content = generateMarketingContent({
    title: (picked && picked.name) || input.title || "AI marketing preview",
    category: (picked && picked.category) || input.category || "",
    price: picked && Number.isFinite(Number(picked.price)) ? Number(picked.price) : input.price,
    image: (picked && picked.image_url) || input.image,
    url: productUrl,
    season: (cfg.sourcing && cfg.sourcing.merchandising && cfg.sourcing.merchandising.seasonNote) || "",
    vibe: (cfg.sourcing && cfg.sourcing.merchandising && cfg.sourcing.merchandising.vibeKeywords) || "",
  });
  const platformCfg = (m.platforms && m.platforms[platform]) || {};
  const result = await provider.dryRunPost(content, { config: m, ...platformCfg });
  const row = {
    id: `mk_${Date.now()}`,
    platform,
    caption: content.caption,
    hashtags: content.hashtags,
    image: content.image,
    url: content.url || "",
    status: result && result.ok ? "posted" : "failed",
    dryRun: true,
    created_at: new Date().toISOString(),
  };
  const posts = [row, ...(m.posts || [])].slice(0, 100);
  await setMarketingConfig(supabase, { posts });
  return { ok: true, preview: row, content };
}

async function listPosts(supabase, limit = 30) {
  const cfg = await getStoreConfig(supabase);
  const m = normalizeMarketingConfig(cfg);
  return (m.posts || []).slice(0, Math.max(1, Math.min(200, Number(limit) || 30)));
}

async function listPostableProducts(supabase, limit = 80) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("products")
    .select("id,name,category,price,score,status,sourcing_status")
    .neq("status", "removed")
    .neq("status", "inactive")
    .order("score", { ascending: false })
    .limit(Math.max(1, Math.min(200, Number(limit) || 80)));
  if (error || !Array.isArray(data)) return [];
  return data.map((p) => ({
    id: p.id,
    name: String(p.name || "Untitled"),
    category: String(p.category || "other"),
    price: Number(p.price) || 0,
    score: Number(p.score) || 0,
  }));
}

async function pickProductForManualPost(supabase, productId = null) {
  if (productId) {
    const { data } = await supabase
      .from("products")
      .select("id,name,category,price,image_url,score,status,sourcing_status")
      .eq("id", String(productId))
      .maybeSingle();
    if (data) return data;
  }
  const { data } = await supabase
    .from("products")
    .select("id,name,category,price,image_url,score,status,sourcing_status")
    .neq("status", "removed")
    .neq("status", "inactive")
    .order("score", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function postNowForPlatform(supabase, input = {}) {
  if (!supabase) return { ok: false, error: "no_db" };
  const platform = String(input.platform || "").toLowerCase();
  if (!["facebook", "instagram", "tiktok"].includes(platform)) {
    return { ok: false, error: "Unsupported platform" };
  }
  const cfg = await getStoreConfig(supabase);
  const m = normalizeMarketingConfig(cfg);
  const pf = m.platforms[platform];
  if (!pf || !pf.connected) return { ok: false, error: "Platform not connected" };
  if (pf.enabled === false) return { ok: false, error: "Platform is disabled" };

  const p = await pickProductForManualPost(supabase, input.productId || null);
  if (!p) return { ok: false, error: "No product found to post" };

  const content = generateMarketingContent({
    title: p.name,
    category: p.category,
    price: p.price,
    image: p.image_url,
    url: `${publicBaseUrl()}/product.html?id=${encodeURIComponent(String(p.id))}`,
    season: (cfg.sourcing && cfg.sourcing.merchandising && cfg.sourcing.merchandising.seasonNote) || "",
    vibe: (cfg.sourcing && cfg.sourcing.merchandising && cfg.sourcing.merchandising.vibeKeywords) || "",
  });
  if (platform === "instagram" && !String(content.image || "").trim()) {
    return {
      ok: false,
      error: "Instagram kræver et produktbillede. Vælg et produkt med image_url eller brug en fallback image URL.",
      code: "missing_image",
    };
  }
  if (platform === "tiktok" && !String(content.image || "").trim()) {
    return {
      ok: false,
      error: "TikTok foto-post kræver et offentligt HTTPS billede (image_url).",
      code: "missing_image",
    };
  }

  const refKey = `manual:${p.id}`;
  const slotKey = marketingPublishLockKey(refKey, platform);
  const slotMs = Math.max(60_000, Number(process.env.MARKETING_PUBLISH_LOCK_MS) || 120_000);

  const out = await runOutboundMarketingPublish(supabase, {
    refKey,
    platform,
    slotKey,
    slotMs,
    dryRun: false,
    publishFn: () => publishToPlatform(platform, pf, content),
    buildRow: (posted, result) => ({
      id: `mk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      platform,
      refKey,
      trigger: "manual",
      product_id: p.id,
      caption: content.caption,
      hashtags: content.hashtags,
      image: content.image,
      url: content.url || "",
      status: posted ? "posted" : "failed",
      error: posted ? null : String((result && result.error) || ""),
      error_class: posted ? null : (result && result.errorClass) || null,
      attempts: (result && result.attempts) || null,
      dryRun: false,
      created_at: new Date().toISOString(),
    }),
  });

  if (out.error) {
    const code = out.error.type === "atomic_lock" ? "atomic_lock_rpc_required" : "publish_guard_rpc_required";
    return { ok: false, error: out.error.message, code };
  }
  if (out.skip) {
    const dedupe = out.reason === "log_already_posted" || out.reason === "durable_already_posted";
    const uncertain = out.reason === "uncertain_publishing";
    return {
      ok: false,
      error:
        out.reason === "dedupe_lock_contention"
          ? "marketing_publish_slot_busy"
          : dedupe
            ? "already_posted_this_platform"
            : uncertain
              ? "publish_in_flight_or_uncertain_state_retry_later"
              : String(out.reason || "skipped"),
      code: uncertain
        ? "uncertain_publishing"
        : out.reason === "dedupe_lock_contention"
          ? "dedupe_lock"
          : dedupe
            ? "dedupe_skip"
            : "skipped",
      dedupe,
      uncertain,
    };
  }

  const { row, result, posted } = out;
  if (posted) return { ok: true, post: row, content, result };
  return {
    ok: false,
    post: row,
    content,
    result,
    error: String((result && result.error) || "Publish failed"),
  };
}

function sameUtcDay(aIso, bIso) {
  const a = new Date(aIso || 0);
  const b = new Date(bIso || 0);
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function postedTodayCount(posts = []) {
  const nowIso = new Date().toISOString();
  return (posts || []).filter((p) => p && p.status === "posted" && sameUtcDay(p.created_at, nowIso)).length;
}

/** One successful (non–dry-run) post per refKey per platform — drives dedupe. */
function alreadySuccessfulPost(posts = [], refKey, platform) {
  const plat = String(platform || "").toLowerCase();
  return (posts || []).some(
    (p) =>
      p &&
      p.refKey === refKey &&
      String(p.platform || "").toLowerCase() === plat &&
      p.status === "posted" &&
      !p.dryRun
  );
}

function marketingPublishLockKey(refKey, platform) {
  const h = crypto.createHash("sha256").update(`${refKey}\0${platform}`, "utf8").digest("hex").slice(0, 48);
  return `marketing_pub_${h}`;
}

/**
 * Atomic automation lock + durable publish guard + provider call + complete + admin log.
 * @returns {Promise<{ ok?: true, skip?: true, reason?: string, posted?: boolean, result?: object, row?: object, savedM?: object, error?: { type: string, message: string } }>}
 */
async function runOutboundMarketingPublish(supabase, ctx) {
  const {
    refKey,
    platform,
    slotKey,
    slotMs,
    dryRun,
    publishFn,
    buildRow,
  } = ctx;
  let gotSlot;
  try {
    gotSlot = await acquireLockAtomic(supabase, slotKey, slotMs);
  } catch (e) {
    if (e instanceof AtomicLockRpcError) {
      return { error: { type: "atomic_lock", message: e.message } };
    }
    throw e;
  }
  if (!gotSlot) {
    return { skip: true, reason: "dedupe_lock_contention" };
  }

  const leaseSec = Math.max(45, Math.min(600, Math.floor(slotMs / 1000)));

  try {
    const latest = normalizeMarketingConfig(await getStoreConfig(supabase));
    if (alreadySuccessfulPost(latest.posts, refKey, platform)) {
      return { skip: true, reason: "log_already_posted" };
    }

    if (!dryRun) {
      const done = await isPublishDone(supabase, refKey, platform);
      if (done) return { skip: true, reason: "durable_already_posted" };

      const slot = await acquirePublishSlot(supabase, refKey, platform, leaseSec);
      if (!slot.allowed) {
        return { skip: true, reason: slot.reason || "publish_slot_denied" };
      }

      const begun = await beginOutboundPublishWithRetry(supabase, refKey, platform);
      if (!begun.ok) {
        if (begun.reason === "uncertain_publishing") {
          logger.info("marketing.publish.uncertain_skip", { refKey, platform, reason: begun.reason });
        }
        return { skip: true, reason: begun.reason || "begin_publish_denied" };
      }
    }

    let result;
    try {
      result = await publishFn();
    } catch (netErr) {
      if (!dryRun) {
        await completePublishDurableWithRetry(
          supabase,
          refKey,
          platform,
          false,
          "",
          String(netErr.message || netErr),
          8
        ).catch(() => {});
      }
      throw netErr;
    }

    const posted = Boolean(dryRun || (result && result.ok));

    if (!dryRun) {
      const attempts = posted ? 28 : 10;
      await completePublishDurableWithRetry(
        supabase,
        refKey,
        platform,
        posted,
        (result && result.id) || "",
        posted ? "" : String((result && result.error) || "publish_failed"),
        attempts
      );
    }

    const row = buildRow(posted, result, latest);
    const savedM = await appendPostLogWithRetry(supabase, latest, row);
    return { ok: true, posted, result, row, savedM };
  } catch (e) {
    if (e instanceof PublishGuardRpcError) {
      logger.error("marketing.publish_guard.rpc_required", {
        message: e.message,
        refKey,
        platform,
      });
      return { error: { type: "publish_guard", message: e.message } };
    }
    throw e;
  } finally {
    await releaseLock(supabase, slotKey);
  }
}

async function publishToPlatform(platform, platformCfg, content) {
  const provider = providerByPlatform(platform);
  if (!provider) return { ok: false, status: "failed", error: "unsupported_platform" };
  return provider.publishPost(content, platformCfg || {});
}

async function appendPostLog(supabase, m, row) {
  const lockKey = "marketing:config";
  const lockTtlMs = 20_000;
  let hasLock = false;
  for (let i = 0; i < 6; i += 1) {
    hasLock = await acquireLock(supabase, lockKey, lockTtlMs);
    if (hasLock) break;
    await new Promise((r) => setTimeout(r, 120 + i * 80));
  }
  if (!hasLock) throw new Error("marketing_config_busy");
  try {
    const latest = normalizeMarketingConfig(await getStoreConfig(supabase));
    const posts = [row, ...(latest.posts || [])].slice(0, 100);
    const saved = await updateStoreConfig(supabase, { marketing: { ...latest, posts } });
    if (saved && saved.status === "error") {
      throw new Error((saved.issues && saved.issues[0] && saved.issues[0].message) || saved.reason || "marketing_post_log_update_failed");
    }
    return normalizeMarketingConfig(saved);
  } finally {
    await releaseLock(supabase, lockKey);
  }
}

async function appendPostLogWithRetry(supabase, m, row, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await appendPostLog(supabase, m, row);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 120 * 2 ** i + Math.floor(Math.random() * 120)));
    }
  }
  throw lastErr || new Error("marketing_post_log_failed");
}

async function runMarketingAutomationCycle(supabase, opts = {}) {
  if (!supabase) return { ok: false, skipped: true, reason: "no_db" };
  const cfg = await getStoreConfig(supabase);
  const m = normalizeMarketingConfig(cfg);
  if (!m.enabled) return { ok: true, skipped: true, reason: "marketing_disabled" };

  const maxPerDay = Number(m.settings && m.settings.maxPostsPerDay) || 3;
  let remainingToday = Math.max(0, maxPerDay - postedTodayCount(m.posts));
  if (remainingToday <= 0) return { ok: true, skipped: true, reason: "daily_limit_reached", posted: 0 };

  const out = { ok: true, posted: 0, failed: 0, skipped: 0, posts: [] };
  const sinceIso = new Date(Date.now() - 24 * 3600000).toISOString();
  const singleProductId = String((opts && opts.singleProductId) || "").trim();
  let rows = [];
  if (singleProductId) {
    const { data: one } = await supabase
      .from("products")
      .select("id,name,category,price,image_url,score,created_at,status,sourcing_status")
      .eq("id", singleProductId)
      .maybeSingle();
    if (one) rows = [one];
  } else {
    const { data: products } = await supabase
      .from("products")
      .select("id,name,category,price,image_url,score,created_at,status,sourcing_status")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(80);
    rows = Array.isArray(products) ? products : [];
  }

  const { data: drops } = await supabase
    .from("price_elasticity")
    .select("product_id,old_price,new_price,observed_at")
    .gt("old_price", 0)
    .gt("new_price", 0)
    .gt("old_price", 1)
    .gte("observed_at", sinceIso)
    .order("observed_at", { ascending: false })
    .limit(80);
  const dropSet = new Set(
    (drops || [])
      .filter((d) => Number(d.old_price) > Number(d.new_price))
      .map((d) => String(d.product_id || ""))
      .filter(Boolean)
  );

  const candidates = [];
  for (const p of rows) {
    if (!p || p.status === "removed" || p.status === "inactive") continue;
    const triggerNew = m.settings.postOnNewProduct && (p.sourcing_status === "approved" || !p.sourcing_status);
    const triggerDrop = m.settings.postOnPriceDrop && dropSet.has(String(p.id || ""));
    const triggerTrend = m.settings.postOnTrendingProduct && Number(p.score) >= 85;
    if (!triggerNew && !triggerDrop && !triggerTrend) continue;
    const trigger = triggerDrop ? "price_drop" : triggerTrend ? "trending" : "new_product";
    candidates.push({ product: p, trigger });
  }

  const slotMs = Math.max(60_000, Number(process.env.MARKETING_PUBLISH_LOCK_MS) || 120_000);

  for (const item of candidates) {
    if (remainingToday <= 0) break;
    const p = item.product;
    const refKey = `${item.trigger}:${p.id}`;
    const content = generateMarketingContent({
      title: p.name,
      category: p.category,
      price: p.price,
      image: p.image_url,
      url: `${publicBaseUrl()}/product.html?id=${encodeURIComponent(String(p.id))}`,
      season: (cfg.sourcing && cfg.sourcing.merchandising && cfg.sourcing.merchandising.seasonNote) || "",
      vibe: (cfg.sourcing && cfg.sourcing.merchandising && cfg.sourcing.merchandising.vibeKeywords) || "",
    });

    for (const platform of ["facebook", "instagram", "tiktok"]) {
      if (remainingToday <= 0) break;
      const pf = m.platforms[platform];
      if (!pf || !pf.connected || pf.enabled === false) continue;

      if (alreadySuccessfulPost(m.posts, refKey, platform)) {
        out.skipped += 1;
        continue;
      }

      const slotKey = marketingPublishLockKey(refKey, platform);
      const cycleOut = await runOutboundMarketingPublish(supabase, {
        refKey,
        platform,
        slotKey,
        slotMs,
        dryRun: Boolean(opts.dryRun),
        publishFn: () =>
          opts.dryRun
            ? Promise.resolve({ ok: true, status: "preview", id: `dry_${platform}_${Date.now()}` })
            : publishToPlatform(platform, pf, content),
        buildRow: (posted, result, latest) => ({
          id: `mk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          platform,
          refKey,
          trigger: item.trigger,
          product_id: p.id,
          caption: content.caption,
          hashtags: content.hashtags,
          image: content.image,
          url: content.url || "",
          status: posted ? "posted" : "failed",
          error: posted ? null : String((result && result.error) || "publish_failed"),
          error_class: posted ? null : (result && result.errorClass) || null,
          attempts: (result && result.attempts) || null,
          dryRun: Boolean(opts.dryRun),
          created_at: new Date().toISOString(),
        }),
      });

      if (cycleOut.error) {
        logger.error("marketing.cycle.publish_pipeline_failed", {
          type: cycleOut.error.type,
          message: cycleOut.error.message,
          refKey,
          platform,
        });
        out.failed += 1;
        out.ok = false;
        continue;
      }
      if (cycleOut.skip) {
        out.skipped += 1;
        continue;
      }

      const { row, posted, savedM } = cycleOut;
      m.posts = savedM.posts || [row, ...(m.posts || [])].slice(0, 100);
      out.posts.push(row);
      if (posted) {
        out.posted += 1;
        remainingToday = Math.max(0, remainingToday - 1);
      } else {
        out.failed += 1;
      }
    }
  }

  return out;
}

async function refreshMarketingTokens(supabase) {
  if (!supabase) return { ok: false, refreshed: 0, failed: 0, skipped: true };
  const cfg = await getStoreConfig(supabase);
  const m = normalizeMarketingConfig(cfg);
  let refreshed = 0;
  let failed = 0;
  const platformsPatch = {};
  const oauthMeta = ((cfg && cfg.marketing && cfg.marketing.oauth_meta) || {});

  try {
    const fbToken = String((m.platforms.facebook && m.platforms.facebook.token) || "");
    if (fbToken && process.env.META_APP_ID && process.env.META_APP_SECRET) {
      const url = new URL("https://graph.facebook.com/v19.0/oauth/access_token");
      url.searchParams.set("grant_type", "fb_exchange_token");
      url.searchParams.set("client_id", String(process.env.META_APP_ID));
      url.searchParams.set("client_secret", String(process.env.META_APP_SECRET));
      url.searchParams.set("fb_exchange_token", fbToken);
      const r = await fetch(url.toString());
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.access_token) {
        platformsPatch.facebook = { ...m.platforms.facebook, token: "", token_enc: encryptToken(String(j.access_token)) || String(j.access_token) };
        refreshed += 1;
      } else {
        failed += 1;
      }
    }
  } catch {
    failed += 1;
  }

  try {
    const ttRefresh = String(oauthMeta.tiktok_refresh_token || "");
    if (ttRefresh && process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET) {
      const body = new URLSearchParams();
      body.set("client_key", String(process.env.TIKTOK_CLIENT_KEY));
      body.set("client_secret", String(process.env.TIKTOK_CLIENT_SECRET));
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", ttRefresh);
      const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.access_token) {
        platformsPatch.tiktok = {
          ...m.platforms.tiktok,
          token: "",
          token_enc: encryptToken(String(j.access_token)) || String(j.access_token),
        };
        oauthMeta.tiktok_refresh_token = String(j.refresh_token || ttRefresh);
        oauthMeta.tiktok_expires_in = Number(j.expires_in) || null;
        oauthMeta.updated_at = new Date().toISOString();
        refreshed += 1;
      } else {
        failed += 1;
      }
    }
  } catch {
    failed += 1;
  }

  if (Object.keys(platformsPatch).length) {
    await setMarketingConfig(supabase, {
      platforms: { ...m.platforms, ...platformsPatch },
      oauth_meta: oauthMeta,
    });
  } else {
    /* no platform token update */
  }
  await updateStoreConfig(supabase, { marketingTokenRefreshLastRunAt: new Date().toISOString() });
  return { ok: true, refreshed, failed };
}

module.exports = {
  getMarketingStatus,
  connectPlatform,
  disconnectPlatform,
  togglePlatform,
  updateMarketingSettings,
  updateMarketingOauthMeta,
  testPost,
  listPosts,
  listPostableProducts,
  runMarketingAutomationCycle,
  postNowForPlatform,
  refreshMarketingTokens,
};
