require("./load-env");

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const Stripe = require("stripe");
const logger = require("./lib/logger");
const obsLogger = require("./services/observability/logger");
const metrics = require("./services/observability/metrics");
const { startAlertEngine } = require("./services/observability/alerts");
const { logDeadLetter } = require("./services/observability/dead-letter");
const { success, failure } = require("./lib/api-response");
const requestIdMiddleware = require("./middleware/request-id");
const requestContext = require("./middleware/request-context");
const observabilityMiddleware = require("./middleware/observability");
const errorHandler = require("./middleware/error-handler");
const {
  globalApiLimiter,
  loginLimiter,
  trackingLimiter,
  sourcingChatLimiter,
  checkoutLimiter,
  validateBody,
  schemas,
} = require("./middleware/security");
const { getSupabase, visibleOnShopfront } = require("./db/supabase");
const {
  getAutomationState,
  findNextSourcingChatCandidate,
  formatChatCandidate,
  insertApprovedSourcingRow,
  insertProvenanceProductsBatch,
  autoFillShopToMax,
  extractSourcingCategoryIntent,
  sourcingCategoryIntentLabelDa,
  setCeoAutomationPaused,
  resetAutomationCircuitBreaker,
  SOURCING_INTERVAL_MS,
  runAutomationCycle,
  runSourcingPass,
  previewAutomationValidator,
} = require("./automation");
const { startAutomationWorker } = require("./services/automation-worker/runner");
const { loadShopifyProductRows } = require("./services/shopify-import");
const {
  listCategoriesMeta,
  enrichProduct,
  VALID_CATEGORY_IDS,
} = require("./services/category");
const {
  STORE_VERTICALS,
  ALL_MERGED_CATEGORY_IDS: TAXONOMY_ALL_CATEGORY_IDS,
  LABELS_DA: TAXONOMY_LABELS_DA,
} = require("./services/store-taxonomy");
const {
  augmentEnrichedProduct,
  productHasColorVariant,
  expandVariantsForProduct,
} = require("./services/variants");
const { evaluateVeldenSourcing } = require("./services/sourcing");
const { resolvedSalePriceMajor } = require("./services/variants");
const {
  STRIPE_CURRENCY,
  shippingAmountMinor,
  productAmountMinor,
  minLineAmountMinor,
  normalizeCountry,
  listShippingOptions,
  isAllowedShippingCountry,
} = require("./services/shipping");
const { optimizeProductSeoDanish } = require("./services/seo");
const { synthesizeGeminiTtsToWav } = require("./services/gemini-tts");
const { collectGeminiApiKeys } = require("./lib/gemini");
const {
  recordUserRemovedProduct,
  recordUserRejectedSourcingCandidate,
} = require("./services/sourcing-memory");
const { logProductTransition } = require("./services/product-state");
const { computeStoreMetrics } = require("./services/business-metrics");
const { trackVariantPerformance } = require("./services/experiments");
const { getLastNDaysTrends } = require("./services/trends");
const { getLearningMetricsSummary } = require("./services/learning-observability");
const { getStoreConfig, updateStoreConfig, sanitizeStoreConfigForClient } = require("./config/store-config");
const { runSourcingHealthChecks } = require("./services/sourcing-health");
const { runAiCeoCycle } = require("./services/ai-ceo/controller");
const {
  getMarketingStatus,
  connectPlatform,
  disconnectPlatform,
  togglePlatform,
  updateMarketingSettings,
  updateMarketingOauthMeta,
  testPost,
  listPosts,
  listPostableProducts,
  postNowForPlatform,
  runMarketingAutomationCycle,
  backfillMarketingConnectionsFromStoreConfig,
} = require("./services/marketing/marketing-engine");
const {
  createOauthState,
  consumeOauthState,
  facebookAuthorizeUrl,
  exchangeFacebookCode,
  tiktokAuthorizeUrl,
  exchangeTikTokCode,
} = require("./services/marketing/oauth");
const { listConnections } = require("./services/marketing/connection-store");
const {
  listFulfillmentQueueWithPriority,
  markFulfillmentQueueCompleted,
} = require("./services/fulfillment/fulfillment-queue");
const { processOrderFulfillment } = require("./services/fulfillment/order-fulfillment");
const { publishEvent } = require("./services/events/bus");
const { EVENTS } = require("./services/events/contracts");
const { startShopEventConsumers } = require("./services/shop-service/event-consumers");
const { computeProductRankScore } = require("./services/ranking/engine");
const {
  listPendingSourcingCandidates,
  updateSourcingCandidateDecision,
} = require("./services/sourcing-candidates");
const {
  getSourcingChatSession,
  upsertSourcingChatSession,
  deleteSourcingChatSession,
} = require("./services/sourcing-chat-sessions");
const { verifyCartLinesInventory, verifySingleProductInventory } = require("./lib/checkout-inventory");
const { detectServerlessRuntime } = require("./lib/run-mode");
const { resolvePublicUrl } = require("./lib/public-url");
const { runSupplierStockSync } = require("./services/supplier-sync");
const { chooseBestProductImage } = require("./services/image-quality");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = resolvePublicUrl();

/** Stripe Checkout afviser ofte product_data.images med http:// — udelad dem. */
function stripeProductImagesList(imageUrl) {
  const u = String(imageUrl || "").trim();
  if (!u) return undefined;
  if (!/^https:\/\//i.test(u)) {
    logger.warn("checkout.product_image_omitted", { reason: "non_https", sample: u.slice(0, 120) });
    return undefined;
  }
  return [u];
}

function responseCheckoutCatchError(err, req, label) {
  let raw = "";
  if (err && typeof err === "object") {
    raw = String(err.message || "").trim();
    if (!raw && err.raw && typeof err.raw === "object") {
      raw = String(err.raw.message || err.raw.description || "").trim();
    }
  }
  if (!raw && err) raw = String(err);
  const stripeType = err && err.type ? String(err.type) : "";
  const ctor = err && err.constructor && err.constructor.name ? String(err.constructor.name) : "";
  const isStripe =
    (typeof stripeType === "string" && stripeType.includes("Stripe")) ||
    ctor.includes("Stripe") ||
    Boolean(err && err.raw && typeof err.raw === "object" && err.raw.type);
  const verboseLocal =
    /^1|true|yes$/i.test(String(process.env.VELDEN_LOCAL || "").trim()) ||
    process.env.NODE_ENV !== "production";
  let error = "Checkout failed";
  if (raw && (isStripe || verboseLocal)) {
    error = raw.length > 320 ? raw.slice(0, 317) + "..." : raw;
  }
  try {
    obsLogger.error(
      "checkout.handler_failed",
      obsLogger.fromRequest(req, { label, stripeType, ctor, message: raw.slice(0, 500) })
    );
  } catch (_) {
    /* ignore */
  }
  logger.error("checkout.handler_failed", { label, stripeType, ctor, message: raw.slice(0, 500) });
  return { error };
}

function normalizeStripeSecretKey(raw) {
  let s = String(raw ?? "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

const stripeSecret = normalizeStripeSecretKey(process.env.STRIPE_SECRET_KEY);
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;
const stripeWebhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();

let supabase = getSupabase();

let veldenServerlessInitLogged = false;

/** Call from Netlify (or Lambda) entry so RUN MODE logs even if NETLIFY env is unset. */
function initializeVeldenServerless(opts = {}) {
  if (veldenServerlessInitLogged) return;
  veldenServerlessInitLogged = true;
  const serverless = opts.forceServerless === true || detectServerlessRuntime();
  if (!serverless) return;
  logger.info("RUN MODE: serverless");
  logger.info("WORKERS: disabled (use POST /api/admin/runtime/* from a scheduler)");
}

app.use(requestIdMiddleware);
app.use(requestContext);
app.use(observabilityMiddleware);
app.use("/api", globalApiLimiter);

/** Stripe webhook must receive raw body for signature verification. */
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ ok: false, error: "Stripe is not configured." });
    if (!stripeWebhookSecret) {
      return res.status(503).json({ ok: false, error: "Missing STRIPE_WEBHOOK_SECRET." });
    }
    const sig = req.headers["stripe-signature"];
    if (!sig) return res.status(400).json({ ok: false, error: "Missing Stripe signature." });
    const event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
    if (event.type === "checkout.session.completed") {
      const session = event.data && event.data.object ? event.data.object : null;
      if (session) {
        const result = await finalizePaidCheckoutSession(session, req);
        if (result && result.pending) {
          return res.json({ ok: true, pending: true });
        }
        if (result && result.ok === false && result.reason === "out_of_stock_at_payment") {
          metrics.increment("checkout.oos_at_payment");
          obsLogger.error(
            "checkout.oos_at_payment",
            obsLogger.fromRequest(req, { sessionId: session.id, source: "webhook" })
          );
          logDeadLetter(
            "checkout.oos_at_payment",
            obsLogger.fromRequest(req, { sessionId: session.id, source: "webhook" })
          );
          return res.status(200).json({ ok: false, reason: result.reason });
        }
        if (result.duplicate) {
          metrics.increment("checkout.duplicate");
          obsLogger.info("checkout.duplicate", obsLogger.fromRequest(req, { sessionId: session.id, source: "webhook" }));
        } else {
          metrics.increment("checkout.success");
          obsLogger.info("checkout.success", obsLogger.fromRequest(req, { sessionId: session.id, source: "webhook", orderId: result.orderId }));
        }
      }
    }
    return res.json({ ok: true });
  } catch (e) {
    metrics.increment("checkout.failed");
    obsLogger.error("checkout.failed", obsLogger.fromRequest(req, { source: "webhook", error: e.message || String(e) }));
    logDeadLetter("checkout.webhook.failed", obsLogger.fromRequest(req, { error: e.message || String(e) }));
    console.error("[stripe.webhook]", e);
    const status = e && e.type === "StripeSignatureVerificationError" ? 400 : 500;
    return res.status(status).json({ ok: false, error: String(e.message || e) });
  }
});

app.use(express.json());

function normalizeChatToken(m) {
  return String(m || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isSourcingChatYes(m) {
  const x = normalizeChatToken(m);
  if (x === "j" || x === "y") return true;
  if (/^(ja|yes|ok|okay|godkend|bekræft|confirm)\b/.test(x)) return true;
  if (
    /\b(vil jeg gerne have|vil jeg godt have|dem vil jeg|den vil jeg|dem tager jeg|den tager jeg|tag den|tag dem|jeg tager den|indsæt|opret (den|det)|add (it|this))\b/i.test(
      String(m || "")
    )
  ) {
    return true;
  }
  return false;
}

function isSourcingChatNo(m) {
  const x = normalizeChatToken(m);
  if (x === "n") return true;
  return /^(nej|ne|no|nope|næste|next|spring\s+over|afvis|decline)\b/.test(x);
}

function adminSecretRequired() {
  return Boolean(normalizeAdminSecretValue(process.env.ADMIN_SECRET));
}

/** Trim + fjern omsluttende anførselstegn fra .env (ADMIN_SECRET="xyz"). */
function normalizeAdminSecretValue(raw) {
  let s = String(raw ?? "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function getCookie(req, name) {
  const raw = String(req.headers.cookie || "");
  if (!raw) return "";
  const parts = raw.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    if (k !== name) continue;
    const v = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return "";
}

function setAdminSecretCookie(res, secret) {
  const value = encodeURIComponent(String(secret || ""));
  const useSecure =
    String(process.env.NODE_ENV || "").toLowerCase() === "production" ||
    String(process.env.NETLIFY || "").toLowerCase() === "true";
  const parts = [`velden_admin_secret=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (useSecure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAdminSecretCookie(res) {
  const useSecure =
    String(process.env.NODE_ENV || "").toLowerCase() === "production" ||
    String(process.env.NETLIFY || "").toLowerCase() === "true";
  const parts = ["velden_admin_secret=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (useSecure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function requireAdmin(req, res, next) {
  const expected = normalizeAdminSecretValue(process.env.ADMIN_SECRET);
  if (!expected) return next();
  const sentHeader = normalizeAdminSecretValue(req.headers["x-admin-secret"]);
  const sentBody = normalizeAdminSecretValue(req.body?.adminSecret);
  const sentQuery = normalizeAdminSecretValue(req.query?.adminSecret);
  const sentCookie = normalizeAdminSecretValue(getCookie(req, "velden_admin_secret"));
  const sent = sentHeader || sentBody || sentQuery || sentCookie;
  const a = Buffer.from(String(sent || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) {
    return failure(
      res,
      401,
      "UNAUTHORIZED",
      "Unauthorized. Send X-Admin-Secret (or adminSecret in body/query) matching ADMIN_SECRET, or clear ADMIN_SECRET for local dev only."
    );
  }
  return next();
}

/** Manual triggers for serverless (Netlify/Lambda): no background worker — call from a cron or external scheduler. */
app.post("/api/admin/runtime/ceo-cycle", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const mode = String(req.body?.mode || "light").toLowerCase() === "full" ? "full" : "light";
    await runAutomationCycle(supabase, { mode });
    res.json({ ok: true, mode });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/admin/runtime/ceo-cycle/dry-run", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const mode = String(req.body?.mode || "light").toLowerCase() === "full" ? "full" : "light";
    await runAutomationCycle(supabase, { mode, dryRun: true });
    const auto = getAutomationState();
    res.json({
      ok: true,
      dryRun: true,
      mode,
      state: {
        running: Boolean(auto.running),
        lastRunAt: auto.lastRunAt || null,
        lastError: auto.lastError || null,
        decisionsLastRun: Array.isArray(auto.decisionsLastRun) ? auto.decisionsLastRun : [],
        productsAddedLastRun: Number(auto.productsAddedLastRun) || 0,
        productsRemovedLastRun: Number(auto.productsRemovedLastRun) || 0,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/admin/runtime/circuit-breaker/reset", requireAdmin, async (_req, res) => {
  try {
    resetAutomationCircuitBreaker();
    const auto = getAutomationState();
    res.json({ ok: true, circuitBreaker: auto.circuitBreaker, ceoAutomationPaused: Boolean(auto.ceoAutomationPaused) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/admin/runtime/validator-preview", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const out = await previewAutomationValidator(supabase, {
      desiredActiveProducts: req.body?.desiredActiveProducts,
      maxInactiveProducts: req.body?.maxInactiveProducts,
    });
    if (!out.ok) return res.status(500).json({ ok: false, error: out.error || "Preview failed" });
    return res.json({ ok: true, ...out.preview });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/admin/runtime/sourcing-pass", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const out = await runSourcingPass(supabase);
    res.json({ ok: true, result: out || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/admin/runtime/marketing-cycle", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const singleProductId = req.body?.productId != null ? String(req.body.productId).trim() : "";
    const out = await runMarketingAutomationCycle(
      supabase,
      singleProductId ? { singleProductId } : {}
    );
    res.json({ ok: true, result: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/admin/runtime/supplier-sync", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const out = await runSupplierStockSync(supabase);
    res.json({ ok: true, result: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

async function logAiToSupabase(action, details) {
  if (!supabase) return;
  try {
    await supabase.from("ai_log").insert({ action, details: details || null });
  } catch (_) {
    /* ignore */
  }
}

async function fetchAiLogTailForBot(limit) {
  const n = Math.min(15, Math.max(1, limit || 5));
  if (!supabase) return [];
  const q = await supabase
    .from("ai_log")
    .select("action, details, created_at")
    .order("created_at", { ascending: false })
    .limit(n);
  if (q.error) return [];
  return q.data || [];
}

function apiOnlyMeta(name, replacements = []) {
  return {
    apiOnly: true,
    endpoint: name,
    replacements,
  };
}

async function buildMarketingAuthorizeUrl(platform) {
  const p = String(platform || "").toLowerCase();
  if (!["facebook", "instagram", "tiktok"].includes(p)) return { ok: false, error: "Unsupported platform" };
  const state = await createOauthState(supabase, { platform: p, store_id: "active", createdAt: new Date().toISOString() });
  if (!state) return { ok: false, error: "Could not create OAuth state" };
  const built = p === "tiktok" ? tiktokAuthorizeUrl({ state }) : facebookAuthorizeUrl({ platform: p, state });
  if (!built || built.ok === false || !built.url) return { ok: false, error: built && built.error ? built.error : "Could not build OAuth URL" };
  const url = built.url;
  return { ok: true, platform: p, url };
}

function detailsFromLogRow(row) {
  return row.details || row.metadata || {};
}

/** Sourcing + ja/nej (sourcing-handleren afviser ja/nej uden pending). */
function shouldRouteToSourcingChat(message, sessionId) {
  const m = String(message || "").trim();
  if (isSourcingChatYes(m) || isSourcingChatNo(m)) return true;
  if (extractSourcingCategoryIntent(m)) return true;
  const low = normalizeChatToken(m);
  if (/^(find|fund|fandt|vis mig|søg efter|giv mig|show me|find me)\s/.test(low)) return true;
  return false;
}

function sourcingChatPolicyBlockAssistant(categoryIntent) {
  const da = categoryIntent ? sourcingCategoryIntentLabelDa(categoryIntent) : "Den kategori";
  return `«${da}» er ikke valgt under Indstillinger → Kategorier. Tilføj den på listen og klik Gem — så bruger sourcing kun de kategorier du har slået til.`;
}

function candidatePayloadToInsertParts(candidate) {
  const c = candidate && typeof candidate === "object" ? candidate : null;
  if (!c) return null;
  const title = String(c.name || "").trim();
  const sourceUrl = String(c.sourceUrl || "").trim();
  const sourcePlatform = String(c.sourcePlatform || "").trim();
  const importMethod = String(c.importMethod || "").trim();
  const sourceProductId = String(c.sourceProductId || "").trim();
  if (!title || !sourceUrl || !sourcePlatform || !importMethod || !sourceProductId) return null;

  const sourcePrice = Number(c.sourcePrice != null ? c.sourcePrice : c.cost);
  const price = Number.isFinite(sourcePrice) && sourcePrice > 0 ? sourcePrice : 0;

  return {
    raw: {
      title,
      price,
      image: String(c.image || "").trim(),
      externalId: sourceProductId,
      sourceUrl,
      sourceProductId,
      sourcePlatform,
      sourceName: String(c.sourceName || "").trim(),
      supplierName: String(c.supplierName || c.sourceName || "").trim(),
      supplierCountry: String(c.supplierCountry || "").trim(),
      importMethod,
    },
    evalResult: {
      title,
      price,
      description: "",
      image: String(c.image || "").trim(),
      category: String(c.category || "").trim() || "other",
      sourcePlatform,
      sourceName: String(c.sourceName || "").trim(),
      sourceUrl,
      sourceProductId,
      supplierName: String(c.supplierName || c.sourceName || "").trim(),
      supplierCountry: String(c.supplierCountry || "").trim(),
      importMethod,
      aiScore: Number.isFinite(Number(c.aiScore)) ? Number(c.aiScore) : 70,
      brandFitReason: String(c.brandFitReason || "").trim(),
      status: "approved",
    },
  };
}

async function handleSourcingChatPost(req, res) {
  try {
    if (!supabase) return dbUnavailable(res);
    const sessionId = String(req.body?.sessionId || "").trim() || "default";
    const message = String(req.body?.message || "").trim();
    if (!message) {
      return res.status(400).json({ ok: false, error: "message is required" });
    }

    const pending = await getSourcingChatSession(supabase, sessionId);

    if (!pending && isSourcingChatYes(message)) {
      const reconstructed = candidatePayloadToInsertParts(req.body?.candidate);
      if (reconstructed) {
        const ins = await insertApprovedSourcingRow(supabase, reconstructed.raw, reconstructed.evalResult);
        if (!ins.ok) {
          return res.json({
            ok: true,
            kind: "error",
            userEcho: message,
            assistantText: ins.error,
            awaitingDecision: false,
          });
        }
        await logAiToSupabase("sourcing_chat_inserted", {
          productId: ins.productId,
          name: ins.name,
          via: "client_candidate_fallback",
        });
        return res.json({
          ok: true,
          kind: "inserted",
          userEcho: message,
          assistantText: ins.mergedVariant
            ? `Farven er tilføjet til det eksisterende produkt «${ins.name}» (samme model som før).`
            : `Produktet er oprettet i kataloget: ${ins.name}.`,
          productId: ins.productId,
          mergedVariant: Boolean(ins.mergedVariant),
          awaitingDecision: false,
        });
      }
    }

    if (!pending && (isSourcingChatYes(message) || isSourcingChatNo(message))) {
      return res.json({
        ok: true,
        kind: "info",
        userEcho: message,
        assistantText:
          "Der afventes ingen produktkandidat. Skriv fx «find sko» eller «vis mig skjorter» først — så kan du svare ja eller nej på forslaget.",
        awaitingDecision: false,
      });
    }

    /* «Nej» før «ja» så fraser som «nej, dem vil jeg ikke» ikke matcher dem-vil-jeg-ja. */
    if (pending && isSourcingChatNo(message)) {
      const hint = pending.lastHint || message;
      const catFromMsg = extractSourcingCategoryIntent(message);
      const categoryIntent = catFromMsg || pending.lastCategoryIntent || null;
      await recordUserRejectedSourcingCandidate(supabase, {
        name: pending.evalResult?.title || pending.raw?.title || "",
        sourceUrl: pending.evalResult?.sourceUrl || pending.raw?.sourceUrl || "",
        sourceProductId:
          pending.evalResult?.sourceProductId || pending.raw?.sourceProductId || pending.raw?.externalId || "",
      });
      await deleteSourcingChatSession(supabase, sessionId);
      const nextCand = await findNextSourcingChatCandidate(supabase, hint, { categoryIntent });
      if (nextCand && nextCand.policyBlock) {
        return res.json({
          ok: true,
          kind: "no_candidate",
          userEcho: message,
          assistantText: sourcingChatPolicyBlockAssistant(nextCand.categoryIntent),
          awaitingDecision: false,
          categoryIntent: nextCand.categoryIntent || undefined,
        });
      }
      if (!nextCand) {
        const da = categoryIntent ? sourcingCategoryIntentLabelDa(categoryIntent) : "";
        return res.json({
          ok: true,
          kind: "no_candidate",
          userEcho: message,
          assistantText: categoryIntent
            ? `Ingen ny kandidat i kategorien «${da}» kunne godkendes i denne omgang (to discovery-forsøg). Prøv igen om lidt, eller tilføj flere seed-URL’er for ${da}.`
            : "Ingen ny passende kandidat i denne runde. Prøv en anden formulering, eller tjek discovery-seeds i .env og prøv igen.",
          awaitingDecision: false,
          categoryIntent: categoryIntent || undefined,
        });
      }
      await upsertSourcingChatSession(supabase, sessionId, {
        raw: nextCand.raw,
        evalResult: nextCand.evalResult,
        lastHint: hint,
        lastCategoryIntent: categoryIntent,
      });
      const c = formatChatCandidate(nextCand.raw, nextCand.evalResult, { categoryIntent });
      await logAiToSupabase("sourcing_chat_candidate", { name: c.name, sourceUrl: c.sourceUrl });
      const note = categoryIntent
        ? ` (Holder os til ${sourcingCategoryIntentLabelDa(categoryIntent)} som aftalt.)`
        : "";
      return res.json({
        ok: true,
        kind: "candidate",
        userEcho: message,
        assistantText: "Her er et nyt forslag." + note + " Vil du oprette dette produkt? Svar ja eller nej.",
        candidate: c,
        awaitingDecision: true,
        categoryIntent: categoryIntent || undefined,
      });
    }

    if (pending && isSourcingChatYes(message)) {
      const ins = await insertApprovedSourcingRow(supabase, pending.raw, pending.evalResult);
      if (!ins.ok) {
        return res.json({
          ok: true,
          kind: "error",
          userEcho: message,
          assistantText: ins.error,
          awaitingDecision: true,
        });
      }
      await deleteSourcingChatSession(supabase, sessionId);
      await logAiToSupabase("sourcing_chat_inserted", {
        productId: ins.productId,
        name: ins.name,
      });
      return res.json({
        ok: true,
        kind: "inserted",
        userEcho: message,
        assistantText: ins.mergedVariant
          ? `Farven er tilføjet til det eksisterende produkt «${ins.name}» (samme model som før).`
          : `Produktet er oprettet i kataloget: ${ins.name}.`,
        productId: ins.productId,
        mergedVariant: Boolean(ins.mergedVariant),
        awaitingDecision: false,
      });
    }

    const prevIntent = pending?.lastCategoryIntent ?? null;
    const categoryIntent = extractSourcingCategoryIntent(message) || prevIntent || null;
    await deleteSourcingChatSession(supabase, sessionId);
    const nextCand = await findNextSourcingChatCandidate(supabase, message, { categoryIntent });
    if (nextCand && nextCand.policyBlock) {
      return res.json({
        ok: true,
        kind: "no_candidate",
        userEcho: message,
        assistantText: sourcingChatPolicyBlockAssistant(nextCand.categoryIntent),
        awaitingDecision: false,
        categoryIntent: nextCand.categoryIntent || undefined,
      });
    }
    if (!nextCand) {
      const da = categoryIntent ? sourcingCategoryIntentLabelDa(categoryIntent) : "";
      return res.json({
        ok: true,
        kind: "no_candidate",
        userEcho: message,
        assistantText: categoryIntent
          ? `Ingen kandidat i kategorien «${da}» kunne godkendes lige nu (to discovery-forsøg). Tjek **kilder** og **seeds** for den kategori, eller prøv igen.`
          : "Ingen kandidat kunne godkendes lige nu. Under **Indstillinger**: vælg **kilder** (web / Shopify / eBay) og **tilladte kategorier** der matcher det du søger — og **Gem config**. Tjek at den valgte kilde er aktiv og har nøgler/URL’er. Hvis kategorier allerede er sat, kan det være tomt discovery (ingen hits) eller midlertidige API-/netfejl.",
        awaitingDecision: false,
        categoryIntent: categoryIntent || undefined,
      });
    }
    await upsertSourcingChatSession(supabase, sessionId, {
      raw: nextCand.raw,
      evalResult: nextCand.evalResult,
      lastHint: message,
      lastCategoryIntent: categoryIntent,
    });
    const c = formatChatCandidate(nextCand.raw, nextCand.evalResult, { categoryIntent });
    await logAiToSupabase("sourcing_chat_candidate", { name: c.name, sourceUrl: c.sourceUrl });
    const note = categoryIntent
      ? ` Viser kun ${sourcingCategoryIntentLabelDa(categoryIntent)} — samme ønske huskes i denne browser-session til du skriver en ny kategori eller «nej» med ny tekst.`
      : "";
    return res.json({
      ok: true,
      kind: "candidate",
      userEcho: message,
      assistantText:
        "Her er ét kandidatforslag." +
        note +
        " Vil du oprette dette produkt i kataloget? Svar ja eller nej.",
      candidate: c,
      awaitingDecision: true,
      categoryIntent: categoryIntent || undefined,
    });
  } catch (e) {
    console.error("[sourcing-chat]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

app.post(
  "/api/admin/sourcing-chat",
  requireAdmin,
  sourcingChatLimiter,
  validateBody(schemas.sourcingChat),
  handleSourcingChatPost
);

async function handleBotAssistant(req, res) {
  try {
    if (!supabase) return dbUnavailable(res);
    const message = String(req.body?.message || "").trim();
    const sessionId = String(req.body?.sessionId || "").trim() || "default";
    if (!message) {
      return res.status(400).json({ ok: false, error: "message is required" });
    }
    if (shouldRouteToSourcingChat(message, sessionId)) {
      return handleSourcingChatPost(req, res);
    }

    const auto = getAutomationState();
    const t = normalizeChatToken(message);

    if (
      /(sidste|seneste)\s+log/.test(t) ||
      /last\s+log/.test(t) ||
      (t.includes("log") && (t.includes("sidste") || t.includes("seneste") || t.includes("last"))) ||
      /hvad\s+(er|står)\s+(i\s+)?(ai\s+)?log/.test(t) ||
      /seneste\s+(ai\s+)?(linje|post|hændelse)/.test(t)
    ) {
      const rows = await fetchAiLogTailForBot(5);
      const lines = rows.map((r) =>
        formatAiLogLine({ action: r.action, details: detailsFromLogRow(r) })
      );
      const assistantText = lines.length
        ? "Seneste fra AI-log:\n" + lines.map((l, i) => `${i + 1}. ${l}`).join("\n")
        : "AI-log er tom lige nu.";
      return res.json({
        ok: true,
        kind: "info",
        userEcho: message,
        assistantText,
        awaitingDecision: false,
      });
    }

    if (
      /(hvordan|how).*(butik|shop|går|going)/.test(t) ||
      /(butik|shop).*(står|status|går)/.test(t) ||
      /går det med butik/.test(t) ||
      /^status\s+(butik|shop)/.test(t)
    ) {
      const { count: activeCount } = await supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .neq("status", "removed");
      const { count: draftCount } = await supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("sourcing_status", "draft")
        .neq("status", "removed");
      const parts = [];
      parts.push(`CEO-automation er ${auto.ceoAutomationPaused ? "på pause" : "aktiv"}.`);
      parts.push(
        `Seneste fulde CEO-løb: ${auto.lastRunAt ? new Date(auto.lastRunAt).toLocaleString("da-DK") : "—"}.`
      );
      if (auto.lastError) parts.push(`Sidste cykelfejl: ${auto.lastError}`);
      parts.push(`Produkter i katalog (ikke fjernet): ${activeCount ?? "?"}.`);
      parts.push(`Kladder (sourcing draft): ${draftCount ?? "?"}.`);
      parts.push(
        `Sourcing-pass sidst: ${auto.sourcingLastRunAt ? new Date(auto.sourcingLastRunAt).toLocaleString("da-DK") : "—"} · indsat ${auto.sourcingLastInserted ?? 0}.`
      );
      if (auto.sourcingLastError) parts.push(`Sourcing-fejl: ${auto.sourcingLastError}`);
      return res.json({
        ok: true,
        kind: "info",
        userEcho: message,
        assistantText: parts.join(" "),
        awaitingDecision: false,
      });
    }

    if (
      /(sidst|seneste|last).*(hentet|fundet|sourcing|kørt|run)/.test(t) ||
      /sourcing.*(sidst|status|seneste)/.test(t) ||
      /hvad har du (sidst )?hentet/.test(t)
    ) {
      const parts = [];
      parts.push(
        `Sourcing-pass sidst kørt: ${auto.sourcingLastRunAt ? new Date(auto.sourcingLastRunAt).toLocaleString("da-DK") : "—"}.`
      );
      parts.push(`Produkter indsat i sidste pass: ${auto.sourcingLastInserted ?? 0}.`);
      if (auto.sourcingRunning) parts.push("Et sourcing-pass kører lige nu.");
      if (auto.sourcingLastError) parts.push(`Fejl: ${auto.sourcingLastError}`);
      else if (!auto.sourcingLastError) parts.push("Ingen registreret sourcing-fejl siden sidste succes.");
      return res.json({
        ok: true,
        kind: "info",
        userEcho: message,
        assistantText: parts.join(" "),
        awaitingDecision: false,
      });
    }

    return res.json({
      ok: true,
      kind: "info",
      userEcho: message,
      assistantText:
        "Skriv fx: «hvad er sidste log», «hvordan går det med butikken», «hvad har du sidst hentet», eller «find sko» / «vis mig skjorter» (så får du et forslag med ja/nej).",
      awaitingDecision: false,
    });
  } catch (e) {
    console.error("[bot-assistant]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

app.post("/api/admin/bot-assistant", requireAdmin, validateBody(schemas.sourcingChat), handleBotAssistant);

/** Gemini TTS for admin voice bot (WAV). Kræver mindst én Gemini-nøgle (GEMINI_API_KEY eller GEMINI_API_KEY_2). */
app.post("/api/admin/bot-tts", requireAdmin, validateBody(schemas.adminBotTts), async (req, res) => {
  try {
    const text = String(req.validatedBody?.text || "").trim();
    if (!text) {
      return res.status(400).json({ ok: false, error: "text is required" });
    }
    const wav = await synthesizeGeminiTtsToWav(text);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    return res.send(wav);
  } catch (e) {
    const msg = String(e.message || e);
    console.warn("[bot-tts]", msg);
    const code = e.code === "NO_KEY" || /API_KEY|API key|403|404/i.test(msg) ? 503 : 502;
    return res.status(code).json({ ok: false, error: msg });
  }
});

/** Browser/curl check: if this 404s, you are not running this codebase (restart server from project root). */
app.get("/api/admin/sourcing-chat", requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    service: "velden-sourcing-chat",
    hint: "POST JSON { sessionId, message } — same path. Chat lives in admin §7.",
  });
});

app.get("/api/admin/ai-feed", requireAdmin, async (_req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const q = await supabase.from("ai_log").select("*").order("created_at", { ascending: false }).limit(280);
    if (q.error) throw q.error;
    const feed = (q.data || []).map((row) => {
      const details = row.metadata || row.details || {};
      return {
        created_at: row.created_at || null,
        cycle_id: row.cycle_id || details.cycleId || null,
        product_id: row.product_id || details.product_id || details.id || null,
        action: row.action,
        message: formatAiLogLine({ action: row.action, details }),
        details,
      };
    });
    return res.json({ ok: true, feed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/admin", (_req, res) => {
  res.redirect(302, "/admin-login.html");
});
app.get("/dashboard", (_req, res) => {
  res.redirect(302, "/admin-login.html");
});
app.get("/admin.html", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});
app.get("/admin/marketing", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin", "marketing.html"));
});
app.get("/admin/marketing/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin", "marketing.html"));
});
app.get("/admin/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin", "dashboard.html"));
});
app.get("/admin/dashboard/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin", "dashboard.html"));
});
app.get("/admin/ai-ceo", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin", "ai-ceo.html"));
});
app.get("/admin/ai-ceo/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin", "ai-ceo.html"));
});

app.post("/api/admin/login", loginLimiter, validateBody(schemas.adminLogin), (req, res) => {
  const expected = normalizeAdminSecretValue(process.env.ADMIN_SECRET);
  if (!expected) return res.json({ ok: true, unlocked: true });
  const sent = normalizeAdminSecretValue(req.validatedBody?.adminSecret);
  const a = Buffer.from(String(sent || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!sent || !match) {
    return res.status(401).json({ ok: false, error: "Forkert kode" });
  }
  setAdminSecretCookie(res, expected);
  return res.json({ ok: true, unlocked: true });
});

app.post("/api/admin/logout", (_req, res) => {
  clearAdminSecretCookie(res);
  return res.json({ ok: true, loggedOut: true });
});

app.use("/api/admin", (req, res, next) => {
  if (req.path === "/login" || req.path === "/logout") return next();
  return requireAdmin(req, res, next);
});

function dbUnavailable(res) {
  return failure(
    res,
    503,
    "DB_UNAVAILABLE",
    "Database is temporarily unavailable. Check Supabase credentials in .env"
  );
}

/** Kundeoplysninger til kurv/checkout — land følger valgt forsendelsesland. */
function checkoutCustomerFromBody(body, shippingCountry) {
  const c = body?.customer || {};
  const fullName = String(c.fullName || "").trim();
  const email = String(c.email || "").trim().toLowerCase();
  const phone = String(c.phone || "").trim();
  const addressLine1 = String(c.addressLine1 || "").trim();
  const postalCode = String(c.postalCode || "").trim();
  const city = String(c.city || "").trim();
  const country = normalizeCountry(shippingCountry);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Angiv en gyldig e-mail." };
  }
  if (fullName.length < 2) return { error: "Angiv dit fulde navn." };
  if (phone.replace(/\D/g, "").length < 6) return { error: "Angiv et telefonnummer." };
  if (addressLine1.length < 4) return { error: "Angiv adresse (vej og nummer)." };
  if (postalCode.length < 2) return { error: "Angiv postnummer." };
  if (city.length < 2) return { error: "Angiv by." };
  if (!isAllowedShippingCountry(country)) return { error: "Valgt land understøttes ikke til levering." };
  return {
    customer: { fullName, email, phone, addressLine1, postalCode, city, country },
  };
}

function stripeSecretKeyShapeHint(secret) {
  const s = String(secret || "").trim();
  if (!s) return { ok: false, code: "missing", hint: "Sæt STRIPE_SECRET_KEY i .env (Secret key fra Stripe Dashboard, sk_test_ eller sk_live_)." };
  if (s.startsWith("pk_")) {
    return {
      ok: false,
      code: "publishable_key",
      hint: "Du har sat publishable key (pk_). Brug Secret key (sk_test_… / sk_live_…) under Developers → API keys.",
    };
  }
  if (!s.startsWith("sk_")) {
    return { ok: false, code: "bad_prefix", hint: "Secret key skal starte med sk_test_ eller sk_live_." };
  }
  if (s.length < 24) {
    return { ok: false, code: "too_short", hint: "Nøglen ser ufuldstændig ud — kopiér hele Secret key fra Stripe." };
  }
  return { ok: true, code: "shape_ok", hint: null };
}

app.get("/api/health", async (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  let databaseReachable = false;
  let checkoutDraftsOk = false;
  if (supabase) {
    try {
      const { error } = await supabase.from("products").select("id").limit(1);
      databaseReachable = !error;
    } catch {
      databaseReachable = false;
    }
    try {
      const { error: dErr } = await supabase.from("checkout_drafts").select("id").limit(1);
      checkoutDraftsOk = !dErr;
    } catch {
      checkoutDraftsOk = false;
    }
  }

  const stripeShape = stripeSecretKeyShapeHint(stripeSecret);
  let stripeApiOk = null;
  let stripeApiMessage = null;
  if (stripe && stripeShape.ok) {
    try {
      await stripe.balance.retrieve();
      stripeApiOk = true;
    } catch (e) {
      stripeApiOk = false;
      stripeApiMessage = e && e.message ? String(e.message).slice(0, 200) : "Stripe API fejl";
    }
  }

  const showStripeDetail =
    /^1|true|yes$/i.test(String(process.env.VELDEN_LOCAL || "").trim()) ||
    process.env.NODE_ENV !== "production";

  const body = {
    healthSchemaVersion: 2,
    healthPath: "/api/health",
    supabase: Boolean(supabase),
    databaseReachable,
    checkoutDraftsReachable: checkoutDraftsOk,
    stripe: Boolean(stripe),
    stripeSecretKeyShape: stripeShape.code,
    stripeSecretKeyOk: stripeShape.ok,
    stripeWebhookSecretSet: Boolean(String(stripeWebhookSecret || "").trim()),
    stripeApiReachable: stripeApiOk,
    gemini: collectGeminiApiKeys().length > 0,
  };
  if (stripeShape.hint) body.stripeHint = stripeShape.hint;
  if (showStripeDetail && stripeApiMessage) body.stripeApiError = stripeApiMessage;
  if (!body.stripeWebhookSecretSet) {
    body.stripeWebhookHint =
      "Webhook er valgfri lokalt hvis success-siden kalder /api/checkout/complete. Til Stripe CLI: stripe listen → sæt STRIPE_WEBHOOK_SECRET=whsec_… i .env";
  }

  const checkoutReady =
    Boolean(supabase) &&
    databaseReachable &&
    checkoutDraftsOk &&
    Boolean(stripe) &&
    stripeShape.ok &&
    stripeApiOk === true;

  body.checkoutReady = checkoutReady;
  body.checkoutBlockers = [];
  if (!checkoutReady) {
    if (!supabase || !databaseReachable) body.checkoutBlockers.push("Supabase: tjek SUPABASE_URL og SUPABASE_SERVICE_ROLE_KEY");
    if (supabase && !checkoutDraftsOk) body.checkoutBlockers.push("Tabel checkout_drafts mangler eller er utilgængelig — kør Supabase-migrationer (schema.sql / migrate_velden_luxury.sql)");
    if (!stripe || !stripeShape.ok) body.checkoutBlockers.push("Stripe: " + (stripeShape.hint || "konfigurer STRIPE_SECRET_KEY"));
    if (stripe && stripeShape.ok && stripeApiOk === false) {
      body.checkoutBlockers.push(
        "Stripe accepterer ikke nøglen: " +
          (stripeApiMessage || "ukendt fejl") +
          " — kopier den fulde Secret key (sk_test_… eller sk_live_…) fra dashboard.stripe.com → Developers → API keys ind i .env og genstart npm run dev."
      );
    }
  }

  return success(res, body, "Health check OK");
});

app.get("/api/categories", async (_req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const { data, error } = await visibleOnShopfront(supabase.from("products").select("category")).neq(
      "status",
      "removed"
    );
    if (error) throw error;
    const rows = data || [];
    const counts = {};
    for (const row of rows) {
      const c = row.category || "other";
      counts[c] = (counts[c] || 0) + 1;
    }
    const meta = listCategoriesMeta();
    const categories = [
      { id: "all", label: "All", count: rows.length },
      ...meta.map((m) => ({
        id: m.id,
        label: m.label,
        count: counts[m.id] || 0,
      })),
    ];
    const labels = Object.fromEntries(meta.map((m) => [m.id, m.label]));
    labels.all = "All";
    res.json({ ok: true, categories, labels });
  } catch (e) {
    console.error(e);
    res.status(503).json({
      ok: false,
      error: "Could not load categories. If the DB is missing column products.category, run supabase/migrate_add_category.sql",
      categories: [],
      labels: {},
    });
  }
});

app.get("/api/filters", async (_req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const { data, error } = await visibleOnShopfront(
      supabase.from("products").select("sizes, color, color_variants")
    ).neq("status", "removed");
    if (error) throw error;
    const sizes = new Set();
    const colors = new Set();
    for (const row of data || []) {
      String(row.sizes || "")
        .split(",")
        .forEach((s) => {
          const t = s.trim();
          if (t) sizes.add(t);
        });
      for (const v of expandVariantsForProduct(row)) {
        const c = String(v.color || "").trim();
        if (c) colors.add(c);
      }
    }
    res.json({
      ok: true,
      sizes: [...sizes].sort(),
      colors: [...colors].sort((a, b) => a.localeCompare(b)),
    });
  } catch (e) {
    console.error(e);
    res.status(503).json({ ok: false, sizes: [], colors: [] });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const cat = String(req.query.category || "")
      .trim()
      .toLowerCase();
    let query = visibleOnShopfront(
      supabase
      .from("products")
      .select(
          "id, name, brand, description, selling_points, price, cost, image_url, image_urls, category, color, color_variants, style_key, sizes, score, status, views, clicks, orders_count, rank_state, rank_last_changed_at"
        )
    );
    query = query.neq("status", "removed").order("score", { ascending: false });
    if (cat && cat !== "all" && VALID_CATEGORY_IDS.includes(cat)) {
      query = query.eq("category", cat);
    }
    const { data, error } = await query;
    if (error) throw error;
    const now = Date.now();
    let products = (data || []).map((p) => {
      const computed = computeProductRankScore({
        views: Number(p.views) || 0,
        clicks: Number(p.clicks) || 0,
        orders: Number(p.orders_count) || 0,
      });
      const score = Number(p.score) > 0 ? Number(p.score) : computed.score;
      const st = String(p.rank_state || "normal");
      const changedAt = p.rank_last_changed_at ? Date.parse(p.rank_last_changed_at) : 0;
      const cooldownMs = (Number(process.env.RANK_STATE_COOLDOWN_HOURS) || 24) * 3600000;
      const cooling = changedAt > 0 && now - changedAt < cooldownMs;
      const stateWeight = st === "boosted" ? 1.2 : st === "deprioritized" ? 0.8 : 1;
      return augmentEnrichedProduct(
        { ...p, score, effective_score: Number((score * stateWeight).toFixed(2)), rank_cooling: cooling },
        enrichProduct(p)
      );
    });
    products = products
      .map((p) => {
        const imageCandidates = [
          ...(Array.isArray(p.images) ? p.images : []),
          String(p.image_url || ""),
          ...(Array.isArray(p.colorVariants) ? p.colorVariants.map((v) => v && v.image_url).filter(Boolean) : []),
        ];
        const best = chooseBestProductImage(imageCandidates);
        if (!best.image) return null;
        return {
          ...p,
          image_url: best.image,
          images: best.accepted.map((x) => x.url).slice(0, 20),
        };
      })
      .filter(Boolean);
    const sizeQ = String(req.query.size || "").trim();
    const colorQ = String(req.query.color || "").trim();
    if (sizeQ) {
      products = products.filter((p) => (p.sizeOptions || []).includes(sizeQ));
    }
    if (colorQ) {
      products = products.filter((p) => productHasColorVariant(p, colorQ));
    }
    products.sort((a, b) => Number(b.effective_score || b.score || 0) - Number(a.effective_score || a.score || 0));
    res.json({ ok: true, products, currency: STRIPE_CURRENCY });
  } catch (e) {
    console.error(e);
    res.status(503).json({
      ok: false,
      error:
        "Could not load products. Run supabase/migrate_velden_luxury.sql and migrate_velden_sourcing.sql if columns are missing.",
      products: [],
      currency: STRIPE_CURRENCY,
    });
  }
});

app.post("/api/newsletter", validateBody(schemas.newsletter), async (req, res) => {
  try {
    const email = String(req.validatedBody.email || "").trim().toLowerCase();
    if (!supabase) {
      console.info("[newsletter]", email);
      return res.json({ ok: true });
    }
    const { error } = await supabase.from("newsletter_subscribers").insert({ email });
    if (error && error.code !== "23505") throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Could not subscribe" });
  }
});

async function getProductById(req, res) {
  try {
    if (!supabase) return dbUnavailable(res);
    const { data, error } = await supabase.from("products").select("*").eq("id", req.params.id).single();
    if (
      error ||
      !data ||
      data.status === "removed" ||
      (data.sourcing_status && data.sourcing_status !== "approved")
    ) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }
    res.json({
      ok: true,
      product: augmentEnrichedProduct(data, enrichProduct(data)),
      currency: STRIPE_CURRENCY,
    });
  } catch (e) {
    res.status(503).json({ ok: false, error: "Could not load product." });
  }
}

app.get("/api/product/:id", getProductById);
app.get("/api/products/:id", getProductById);

app.post("/api/track/view", trackingLimiter, validateBody(schemas.trackEvent), async (req, res) => {
  try {
    if (!supabase) {
      obsLogger.warn("tracking.view.db_unavailable", obsLogger.fromRequest(req));
      return res.json({ ok: true, skipped: true });
    }
    const { productId } = req.validatedBody;
    const { data, error } = await withDbRetry(
      "tracking.view.increment",
      () =>
        supabase.rpc("increment_product_counters", {
          p_product_id: productId,
          p_views_inc: 1,
          p_clicks_inc: 0,
          p_orders_inc: 0,
        }),
      2,
      req
    );
    if (error || !Array.isArray(data) || !data.length) {
      logger.error("tracking.view.increment_failed", { productId, error: error ? error.message : "no row" });
      obsLogger.warn("tracking.view.failed", obsLogger.fromRequest(req, { productId, error: error ? error.message : "no row" }));
      return res.json({ ok: true, skipped: true });
    }
    await publishEvent(EVENTS.PRODUCT_VIEWED, { productId, views: 1 });
    res.json({ ok: true });
  } catch (e) {
    logger.error("tracking.view.error", { error: e.message || String(e) });
    obsLogger.warn("tracking.view.failed", obsLogger.fromRequest(req, { error: e.message || String(e) }));
    res.json({ ok: true, skipped: true });
  }
});

app.post("/api/track/click", trackingLimiter, validateBody(schemas.trackEvent), async (req, res) => {
  try {
    if (!supabase) {
      obsLogger.warn("tracking.click.db_unavailable", obsLogger.fromRequest(req));
      return res.json({ ok: true, skipped: true });
    }
    const { productId } = req.validatedBody;
    const { data, error } = await withDbRetry(
      "tracking.click.increment",
      () =>
        supabase.rpc("increment_product_counters", {
          p_product_id: productId,
          p_views_inc: 0,
          p_clicks_inc: 1,
          p_orders_inc: 0,
        }),
      2,
      req
    );
    if (error || !Array.isArray(data) || !data.length) {
      logger.error("tracking.click.increment_failed", { productId, error: error ? error.message : "no row" });
      obsLogger.warn("tracking.click.failed", obsLogger.fromRequest(req, { productId, error: error ? error.message : "no row" }));
      return res.json({ ok: true, skipped: true });
    }
    await publishEvent(EVENTS.PRODUCT_CLICKED, { productId, clicks: 1 });
    res.json({ ok: true });
  } catch (e) {
    logger.error("tracking.click.error", { error: e.message || String(e) });
    obsLogger.warn("tracking.click.failed", obsLogger.fromRequest(req, { error: e.message || String(e) }));
    res.json({ ok: true, skipped: true });
  }
});

app.get("/api/shipping", (_req, res) => {
  res.json({
    ok: true,
    currency: STRIPE_CURRENCY,
    countries: listShippingOptions(),
  });
});

/**
 * eBay "Marketplace Account Deletion" endpoint verification.
 * eBay calls: GET <endpoint>?challenge_code=...
 * We must respond 200 JSON: { "challengeResponse": "<sha256 hex>" }
 * Hash input order: challenge_code + verificationToken + endpoint (full URL string).
 */
app.get("/api/ebay/account-deletion", (req, res) => {
  const challengeCode = String(req.query.challenge_code || "").trim();
  if (!challengeCode) return res.status(400).json({ ok: false, error: "challenge_code is required" });

  const verificationToken = String(process.env.EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN || "").trim();
  if (!verificationToken) {
    return res.status(503).json({
      ok: false,
      error: "Missing EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN env var",
    });
  }

  // The endpoint string must exactly match what you entered in eBay (including path).
  const endpoint =
    String(process.env.EBAY_ACCOUNT_DELETION_ENDPOINT || "").trim() ||
    `${PUBLIC_URL}/api/ebay/account-deletion`;

  const challengeResponse = crypto
    .createHash("sha256")
    .update(challengeCode)
    .update(verificationToken)
    .update(endpoint)
    .digest("hex");

  res.setHeader("Content-Type", "application/json");
  return res.status(200).json({ challengeResponse });
});

/**
 * eBay sends actual deletion notifications as POST requests to the same endpoint.
 * Best practice: ack quickly (202) then process async.
 */
app.post("/api/ebay/account-deletion", (req, res) => {
  try {
    console.info("[ebay.account-deletion] notification", {
      receivedAt: new Date().toISOString(),
      bodyKeys: req.body && typeof req.body === "object" ? Object.keys(req.body) : [],
    });
  } catch {
    /* ignore */
  }
  return res.status(202).json({ ok: true });
});

app.post("/api/checkout", checkoutLimiter, validateBody(schemas.checkoutSingle), async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ ok: false, error: "Stripe is not configured." });
    }
    if (!supabase) return dbUnavailable(res);
    const { productId, shippingCountry: scRaw, color: colorHint } = req.validatedBody || {};
    if (!productId) return res.status(400).json({ ok: false, error: "productId required" });
    const shippingCountry = normalizeCountry(scRaw);
    const custRes = checkoutCustomerFromBody(req.validatedBody, shippingCountry);
    if (custRes.error) return res.status(400).json({ ok: false, error: custRes.error });
    const { customer } = custRes;

    const { data: product, error } = await supabase.from("products").select("*").eq("id", productId).single();
    if (
      error ||
      !product ||
      product.status === "removed" ||
      product.available === false ||
      (product.sourcing_status && product.sourcing_status !== "approved")
    ) {
      return res.status(404).json({ ok: false, error: "Product not available" });
    }

    const priceMajor = resolvedSalePriceMajor(product, colorHint);
    const singleVariants = Array.isArray(product.supplier_variants)
      ? product.supplier_variants
      : typeof product.supplier_variants === "string"
      ? (() => {
          try {
            const j = JSON.parse(product.supplier_variants);
            return Array.isArray(j) ? j : [];
          } catch {
            return [];
          }
        })()
      : [];
    if (singleVariants.length && colorHint) {
      const hit = singleVariants.find((v) => String((v && v.color) || "").trim().toLowerCase() === String(colorHint).trim().toLowerCase());
      if (hit && hit.available === false) {
        return res.status(400).json({ ok: false, error: "Selected variant is out of stock" });
      }
    }
    const unitAmount = productAmountMinor(priceMajor);
    if (unitAmount < minLineAmountMinor()) {
      return res.status(400).json({ ok: false, error: "Invalid price" });
    }

    const shipMinor = shippingAmountMinor(shippingCountry);
    const line_items = [
        {
          quantity: 1,
          price_data: {
          currency: STRIPE_CURRENCY,
            unit_amount: unitAmount,
            product_data: {
              name: product.name,
              description: (product.brand ? `${product.brand} — ` : "") + (product.description || "").slice(0, 500),
              images: stripeProductImagesList(product.image_url),
            },
          },
        },
    ];
    if (shipMinor > 0) {
      line_items.push({
        quantity: 1,
        price_data: {
          currency: STRIPE_CURRENCY,
          unit_amount: shipMinor,
          product_data: {
            name: `Fragt (${shippingCountry})`,
            description: "Standard forsendelse",
          },
        },
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      customer_email: customer.email,
      success_url: `${PUBLIC_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/product.html?id=${encodeURIComponent(productId)}`,
      metadata: {
        product_id: product.id,
        variant_color: colorHint ? String(colorHint).trim().slice(0, 120) : "",
        variant_size: "",
        shipping_country: shippingCountry,
        cust_name: customer.fullName.slice(0, 500),
        cust_email: customer.email.slice(0, 500),
        cust_phone: customer.phone.slice(0, 500),
        ship_line1: customer.addressLine1.slice(0, 500),
        ship_postal: customer.postalCode.slice(0, 100),
        ship_city: customer.city.slice(0, 200),
        ship_country: customer.country,
      },
    });

    res.json({ ok: true, url: session.url });
  } catch (e) {
    const out = responseCheckoutCatchError(e, req, "checkout.single");
    res.status(500).json({ ok: false, error: out.error });
  }
});

app.post("/api/checkout/cart", checkoutLimiter, validateBody(schemas.checkoutCart), async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ ok: false, error: "Stripe is not configured." });
    }
    if (!supabase) return dbUnavailable(res);
    const items = req.validatedBody?.items;
    const shippingCountry = normalizeCountry(req.validatedBody?.shippingCountry);
    const custRes = checkoutCustomerFromBody(req.validatedBody, shippingCountry);
    if (custRes.error) return res.status(400).json({ ok: false, error: custRes.error });
    const { customer } = custRes;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ ok: false, error: "items required" });
    }
    if (items.length > 25) {
      return res.status(400).json({ ok: false, error: "Too many line items" });
    }

    const normalized = [];
    for (const it of items) {
      const pid = it.productId;
      const qty = Math.min(10, Math.max(1, parseInt(it.quantity, 10) || 1));
      if (!pid) continue;
      const { data: product, error } = await supabase.from("products").select("*").eq("id", pid).single();
      if (
        error ||
        !product ||
        product.status === "removed" ||
        product.available === false ||
        (product.sourcing_status && product.sourcing_status !== "approved")
      ) {
        return res.status(400).json({ ok: false, error: "A product is no longer available" });
      }
      const size = String(it.size || "").trim() || null;
      const color = String(it.color || product.color || "").trim() || null;
      const variants = Array.isArray(product.supplier_variants)
        ? product.supplier_variants
        : typeof product.supplier_variants === "string"
        ? (() => {
            try {
              const j = JSON.parse(product.supplier_variants);
              return Array.isArray(j) ? j : [];
            } catch {
              return [];
            }
          })()
        : [];
      if (variants.length) {
        const selected = variants.find((v) => {
          const vs = String((v && v.size) || "").trim();
          const vc = String((v && v.color) || "").trim();
          const sizeOk = !size || !vs || vs === size;
          const colorOk = !color || !vc || vc.toLowerCase() === color.toLowerCase();
          return sizeOk && colorOk;
        });
        if (selected && selected.available === false) {
          return res.status(400).json({ ok: false, error: "Selected variant is out of stock" });
        }
      }
      const priceMajor = resolvedSalePriceMajor(product, color);
      const unitAmount = productAmountMinor(priceMajor);
      if (unitAmount < minLineAmountMinor()) {
        return res.status(400).json({ ok: false, error: "Invalid price" });
      }
      normalized.push({
        product_id: product.id,
        name: product.name,
        quantity: qty,
        size,
        color,
        unit_amount_cents: unitAmount,
        image_url: product.image_url || null,
      });
    }

    if (!normalized.length) {
      return res.status(400).json({ ok: false, error: "No valid items" });
    }

    const { data: draft, error: draftErr } = await supabase
      .from("checkout_drafts")
      .insert({ items: normalized })
      .select("id")
      .single();
    if (draftErr || !draft) {
      console.error(draftErr);
      return res.status(500).json({ ok: false, error: "Could not start checkout" });
    }

    const line_items = normalized.map((l) => {
      const bits = [l.color, l.size].filter(Boolean);
      const desc = bits.length ? bits.join(" · ") : (l.name || "").slice(0, 120);
      return {
        quantity: l.quantity,
        price_data: {
          currency: STRIPE_CURRENCY,
          unit_amount: l.unit_amount_cents,
          product_data: {
            name: l.size ? `${l.name} — Size ${l.size}` : l.name,
            description: desc.slice(0, 500),
            images: stripeProductImagesList(l.image_url),
          },
        },
      };
    });

    const shipMinor = shippingAmountMinor(shippingCountry);
    if (shipMinor > 0) {
      line_items.push({
        quantity: 1,
        price_data: {
          currency: STRIPE_CURRENCY,
          unit_amount: shipMinor,
          product_data: {
            name: `Fragt (${shippingCountry})`,
            description: "Standard forsendelse",
          },
        },
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      customer_email: customer.email,
      success_url: `${PUBLIC_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/checkout.html`,
      metadata: {
        checkout_draft_id: draft.id,
        shipping_country: shippingCountry,
        cust_name: customer.fullName.slice(0, 500),
        cust_email: customer.email.slice(0, 500),
        cust_phone: customer.phone.slice(0, 500),
        ship_line1: customer.addressLine1.slice(0, 500),
        ship_postal: customer.postalCode.slice(0, 100),
        ship_city: customer.city.slice(0, 200),
        ship_country: customer.country,
      },
    });

    res.json({ ok: true, url: session.url });
  } catch (e) {
    const out = responseCheckoutCatchError(e, req, "checkout.cart");
    res.status(500).json({ ok: false, error: out.error });
  }
});

async function withDbRetry(taskName, fn, maxAttempts = 3, req = null) {
  let lastErr = null;
  for (let i = 1; i <= maxAttempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      metrics.increment("db.retry");
      obsLogger.warn("db.retry", obsLogger.fromRequest(req, { taskName, attempt: i, error: e.message || String(e) }));
      logger.warn("db.retry", { taskName, attempt: i, error: e.message || String(e) });
      if (i < maxAttempts) await new Promise((r) => setTimeout(r, i * 120));
    }
  }
  metrics.increment("db.retry.failed");
  obsLogger.error("db.retry.failed", obsLogger.fromRequest(req, { taskName, maxAttempts, error: lastErr && (lastErr.message || String(lastErr)) }));
  logDeadLetter("db.retry.failed", obsLogger.fromRequest(req, { taskName, maxAttempts, error: lastErr && (lastErr.message || String(lastErr)) }));
  throw lastErr;
}

async function finalizePaidCheckoutSession(session, req = null) {
  if (!stripe || !supabase) throw new Error("Checkout backend is not configured");
  if (!session || session.payment_status !== "paid") return { pending: true };

  const sessionId = session.id;
  const { data: processedRow, error: procReadErr } = await supabase
    .from("checkout_session_process_log")
    .select("order_id")
    .eq("stripe_session_id", sessionId)
    .maybeSingle();
  if (!procReadErr && processedRow && processedRow.order_id) {
    return { orderId: processedRow.order_id, duplicate: true };
  }

  const draftId = session.metadata?.checkout_draft_id;
  const productId = session.metadata?.product_id;
  const variantColor =
    session.metadata?.variant_color != null ? String(session.metadata.variant_color).trim() : "";
  const variantSize =
    session.metadata?.variant_size != null ? String(session.metadata.variant_size).trim() : "";
  const amountCents = session.amount_total;
  const email =
    session.customer_details?.email || session.customer_email || session.metadata?.cust_email || null;

  const customerFromMeta =
    session.metadata?.cust_email && session.metadata?.cust_name
      ? {
          fullName: session.metadata.cust_name,
          email: session.metadata.cust_email,
          phone: session.metadata.cust_phone || "",
          addressLine1: session.metadata.ship_line1 || "",
          postalCode: session.metadata.ship_postal || "",
          city: session.metadata.ship_city || "",
          country: session.metadata.ship_country || "",
        }
      : null;

  if (draftId) {
    const { data: draft, error: dErr } = await supabase
      .from("checkout_drafts")
      .select("items")
      .eq("id", draftId)
      .maybeSingle();
    if (dErr || !draft?.items) {
      throw new Error("Checkout draft expired");
    }
    const lines = draft.items;
    const inv = await verifyCartLinesInventory(supabase, lines);
    if (!inv.ok) {
      return { ok: false, reason: "out_of_stock_at_payment" };
    }
    const supplier_data = {
      lines,
      shippingCountry: session.metadata?.shipping_country || null,
      customerEmail: email,
      customer: customerFromMeta,
      sessionId,
      placedAt: new Date().toISOString(),
      note: "Velden — fulfill from line_items.",
    };

    const { data: out, error: txErr } = await withDbRetry("checkout.atomic.cart", () =>
      supabase.rpc("process_checkout_session_atomic", {
        p_stripe_session_id: sessionId,
        p_product_id: null,
        p_line_items: lines,
        p_amount_cents: amountCents,
        p_currency: session.currency || "usd",
        p_customer_email: email,
        p_supplier_data: supplier_data,
        p_checkout_draft_id: draftId,
      }),
      3,
      req
    );
    if (txErr || !Array.isArray(out) || !out.length) throw txErr || new Error("Atomic checkout RPC failed");
    const ins = { orderId: out[0].order_id, duplicate: Boolean(out[0].duplicate) };
    if (!ins.duplicate) {
      for (const line of lines) {
        const pid = line.product_id;
        const q = Number(line.quantity) || 1;
        if (!pid) continue;
        await publishEvent(EVENTS.ORDER_COMPLETED, {
          orderId: ins.orderId,
          productId: pid,
          qty: q,
          revenue: Number(amountCents) / 100,
        });
      }
      // Serverless-safe fallback: run fulfillment even if no event consumer is attached in this process.
      await processOrderFulfillment(supabase, { orderId: ins.orderId });
    }
    return { orderId: ins.orderId, duplicate: ins.duplicate };
  }

  const invSingle = await verifySingleProductInventory(supabase, productId, {
    color: variantColor,
    size: variantSize,
  });
  if (!invSingle.ok) {
    return { ok: false, reason: "out_of_stock_at_payment" };
  }

  const supplier_data = {
    productId,
    customerEmail: email,
    customer: customerFromMeta,
    sessionId,
    placedAt: new Date().toISOString(),
    note: "Velden — fulfill via supplier using products.external_id where applicable.",
  };

  const { data: out, error: txErr } = await withDbRetry("checkout.atomic.single", () =>
    supabase.rpc("process_checkout_session_atomic", {
      p_stripe_session_id: sessionId,
      p_product_id: productId || null,
      p_line_items: null,
      p_amount_cents: amountCents,
      p_currency: session.currency || "usd",
      p_customer_email: email,
      p_supplier_data: supplier_data,
      p_checkout_draft_id: null,
    }),
    3,
    req
  );
  if (txErr || !Array.isArray(out) || !out.length) throw txErr || new Error("Atomic checkout RPC failed");
  const ins = { orderId: out[0].order_id, duplicate: Boolean(out[0].duplicate) };
  if (productId && !ins.duplicate) {
    await publishEvent(EVENTS.ORDER_COMPLETED, {
      orderId: ins.orderId,
      productId,
      qty: 1,
      revenue: Number(amountCents) / 100,
    });
    // Serverless-safe fallback: run fulfillment directly for environments without a live consumer.
    await processOrderFulfillment(supabase, { orderId: ins.orderId });
  }
  return { orderId: ins.orderId, duplicate: ins.duplicate };
}

async function cleanupOldSourcingChatSessions() {
  if (!supabase) return;
  const maxAgeHours = Math.max(1, Number(process.env.SOURCING_CHAT_SESSION_TTL_HOURS) || 24);
  const cutoff = new Date(Date.now() - maxAgeHours * 3600000).toISOString();
  const { error } = await supabase.from("sourcing_chat_sessions").delete().lt("updated_at", cutoff);
  if (error) {
    logger.warn("sourcing_chat.cleanup.failed", { error: error.message || String(error) });
  }
}

app.get("/api/checkout/complete", async (req, res) => {
  try {
    if (!stripe || !supabase) return res.status(503).json({ ok: false });
    const sessionId = req.query.session_id;
    if (!sessionId) return res.status(400).json({ ok: false });

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items"],
    });

    const result = await finalizePaidCheckoutSession(session, req);
    if (result.pending) return res.json({ ok: true, pending: true });
    if (result.ok === false && result.reason === "out_of_stock_at_payment") {
      metrics.increment("checkout.oos_at_payment");
      obsLogger.error("checkout.oos_at_payment", obsLogger.fromRequest(req, { sessionId, source: "success_endpoint" }));
      logDeadLetter("checkout.oos_at_payment", obsLogger.fromRequest(req, { sessionId, source: "success_endpoint" }));
      return res.status(409).json({ ok: false, reason: result.reason });
    }
    if (result.duplicate) {
      metrics.increment("checkout.duplicate");
      obsLogger.info("checkout.duplicate", obsLogger.fromRequest(req, { sessionId, source: "success_endpoint" }));
    } else {
      metrics.increment("checkout.success");
      obsLogger.info("checkout.success", obsLogger.fromRequest(req, { sessionId, source: "success_endpoint", orderId: result.orderId }));
    }
    return res.json({ ok: true, orderId: result.orderId, duplicate: Boolean(result.duplicate) });
  } catch (e) {
    metrics.increment("checkout.failed");
    obsLogger.error("checkout.failed", obsLogger.fromRequest(req, { source: "success_endpoint", error: e.message || String(e) }));
    logDeadLetter("checkout.success_endpoint.failed", obsLogger.fromRequest(req, { error: e.message || String(e) }));
    console.error(e);
    res.status(500).json({ ok: false, error: "Could not finalize order" });
  }
});

function formatAiLogLine(row) {
  const a = row.action;
  const d = row.details || {};
  if (a === "product_removed") return `Removed product: ${d.name || d.id || "?"}`;
  if (a === "product_scaled") return `Marked for scale: ${d.name || d.id || "?"}`;
  if (a === "price_updated")
    return `Price updated: ${d.name || d.id} → $${d.newPrice} (was $${d.oldPrice})`;
  if (a === "product_added") {
    const why = d.brand_fit_reason ? ` — ${String(d.brand_fit_reason).slice(0, 160)}` : "";
    return `Added product: ${d.name || "?"} @ $${d.price}${d.sourcing_status ? ` [${d.sourcing_status}]` : ""}${why}`;
  }
  if (a === "product_variant_merged")
    return `Colour variant merged into «${d.name || "?"}» (${d.variant_color || d.external_id || "—"})`;
  if (a === "product_sourcing_rejected") {
    const r = d.reason || d.brandFitReason || "";
    const tr = d.meta && d.meta.trace ? JSON.stringify(d.meta.trace) : "";
    return `Sourcing rejected: ${d.title || "?"} (score ${d.aiScore ?? "—"})${r ? ` — ${String(r).slice(0, 200)}` : ""}${tr ? ` · trace ${tr.slice(0, 220)}` : ""}`;
  }
  if (a === "content_regenerated") return `Marketing content: ${d.name || d.productId}`;
  if (a === "cycle_complete")
    return `Cycle complete — inserted ${d.inserted ?? 0}, removed ${d.removeProductIds ?? 0}, price tweaks ${d.priceUpdates ?? 0}, content targets ${d.contentTargets ?? 0}`;
  if (a === "cycle_error") return `Error: ${d.error || "unknown"}`;
  if (a === "sourcing_pass_complete") {
    const ins = d.inserted ?? 0;
    const seen = d.candidatesSeen ?? "—";
    const tgt = d.target ?? "—";
    let s = `Sourcing pass · indsat ${ins} (rå kandidater ${seen}, mål ${tgt})`;
    if (ins === 0 && Number(d.candidatesSeen) > 0) {
      const bits = [];
      if (Number(d.rejectedCount) > 0) bits.push(`${d.rejectedCount} afvist af brand/AI-fit`);
      if (Number(d.skippedSourcePolicy) > 0) bits.push(`${d.skippedSourcePolicy} sprunget over (kilde-policy)`);
      if (Number(d.skippedCategoryCap) > 0) bits.push(`${d.skippedCategoryCap} sprunget over (kategoriloft)`);
      if (Number(d.qualifiedAfterAi) >= 0) bits.push(`${d.qualifiedAfterAi} kvalificeret efter AI til indsættelse`);
      s += bits.length ? " — " + bits.join(" · ") : " — tjek «product_sourcing_rejected» i log";
    }
    return s;
  }
  if (a === "sourcing_pass_error") return `Sourcing pass error: ${d.error || "unknown"}`;
  if (a === "sourcing_chat_candidate") return `Sourcing chat · candidate: ${d.name || "?"} (${d.sourceUrl || "—"})`;
  if (a === "sourcing_chat_inserted") return `Sourcing chat · inserted: ${d.name || d.productId || "?"}`;
  if (a === "product_deleted_dashboard") return `Dashboard · product removed: ${d.name || d.id || "?"}`;
  if (a === "product_restored_dashboard") return `Dashboard · product restored: ${d.name || d.id || "?"}`;
  if (a === "product_seo_optimized")
    return `SEO opdateret (DA): ${d.name || d.id || "?"}${d.note ? " — " + d.note : ""}`;
  if (a === "sourcing_skipped_user_memory")
    return `Sourcing sprunget over (hukommelse): ${d.title || "?"} — ${d.reason || ""}`;
  if (a === "sourcing_skipped_source_policy")
    return `Sourcing: ${d.count ?? 0} kandidat afvist — kilde ikke i enabledSources (prøver: ${(d.samples || []).length} vist)`;
  if (a === "sourcing_skipped_category_cap")
    return `Sourcing sprunget over (kategoriloft): ${d.title || "?"} [${d.category || "?"}]`;
  if (a === "sourcing_no_candidates") {
    const m = d.meta || {};
    return `Sourcing · 0 kandidater (web=${m.webEnabled ?? "—"}, shopify=${m.shopifyEnabled ?? "—"}) kilder=${JSON.stringify(
      m.enabledSources || []
    )} kat=${JSON.stringify(m.allowedCategories || [])}`;
  }
  if (a === "sourcing_run_started") {
    const m = d.meta || {};
    return `Sourcing run start · runId ${m.runId || d.runId || "?"} kilder=${JSON.stringify(m.enabledSources || [])}`;
  }
  if (a === "sourcing_run_completed") {
    const m = d.meta || {};
    return `Sourcing run færdig · runId ${m.runId || d.runId || "?"} total=${m.totalCandidates ?? "—"} accepteret=${m.acceptedCount ?? "—"} afvist=${m.rejectedCount ?? "—"} skip-kilde=${m.skippedBySource ?? "—"} skip-kat=${m.skippedByCategory ?? "—"}`;
  }
  if (a === "admin_ceo_automation_pause")
    return d.paused
      ? "Admin · CEO-automation sat på pause"
      : "Admin · CEO-automation genstartet (pause slået fra)";
  if (a === "admin_purge_all_products") return `Admin · alle produkter slettet (${d.deleted ?? 0} rækker)`;
  if (a === "admin_shopify_import_complete")
    return `Shopify-import færdig · ${d.origin || "?"} — indsat ${d.inserted ?? 0}, merge ${d.merged ?? 0}, sprunget over ${d.skipped ?? 0}`;
  if (a === "shopify_import_row") return `Shopify-import · ${d.name || "?"}`;
  return `${a}${Object.keys(d).length ? " · " + JSON.stringify(d) : ""}`;
}

async function handleDashboardProductRemove(req, res) {
  try {
    if (!supabase) return dbUnavailable(res);
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const { data: before } = await supabase
      .from("products")
      .select("id, status, sourcing_status")
      .eq("id", id)
      .maybeSingle();
    const cooldownDays = Math.max(1, Number(process.env.REMOVE_COOLDOWN_DAYS) || 14);
    const cooldownUntil = new Date(Date.now() + cooldownDays * 24 * 60 * 60 * 1000).toISOString();
    const { data: rows, error } = await supabase
      .from("products")
      .update({ status: "removed", cooldown_until: cooldownUntil, updated_at: new Date().toISOString() })
      .eq("id", id)
      .neq("status", "removed")
      .select("id, name, external_id, source_url, source_product_id");
    if (error) throw error;
    const data = rows && rows[0];
    if (!data) {
      return res.status(404).json({
        ok: false,
        error: "Product not found or already removed",
      });
    }
    await recordUserRemovedProduct(supabase, data);
    await logProductTransition(supabase, {
      product_id: data.id,
      from_status: before?.status || null,
      to_status: "removed",
      from_sourcing: before?.sourcing_status || null,
      to_sourcing: before?.sourcing_status || null,
      reason: "admin_remove",
      actor_type: "admin",
      actor_id: "dashboard",
    });
    await logAiToSupabase("product_deleted_dashboard", { id: data.id, name: data.name });
    res.json({ ok: true, product: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: e.message || String(e) || "Could not remove product",
    });
  }
}

/** POST fallback — nogle netværk/browser-setup blokerer DELETE med custom headers. */
app.post("/api/admin/products/:id/remove", requireAdmin, handleDashboardProductRemove);
app.delete("/api/admin/products/:id", requireAdmin, handleDashboardProductRemove);

app.post("/api/admin/products/:id/restore", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const { data: before } = await supabase
      .from("products")
      .select("id, name, status, sourcing_status")
      .eq("id", id)
      .maybeSingle();
    if (!before) return res.status(404).json({ ok: false, error: "Product not found" });
    const { data: updated, error } = await supabase
      .from("products")
      .update({
        status: "active",
        cooldown_until: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "removed")
      .select("id, name, status, sourcing_status")
      .maybeSingle();
    if (error) throw error;
    if (!updated) return res.status(404).json({ ok: false, error: "Product is not in trash" });
    await logProductTransition(supabase, {
      product_id: updated.id,
      from_status: before?.status || null,
      to_status: updated.status || null,
      from_sourcing: before?.sourcing_status || null,
      to_sourcing: updated.sourcing_status || null,
      reason: "admin_restore",
      actor_type: "admin",
      actor_id: "dashboard",
    });
    await logAiToSupabase("product_restored_dashboard", { id: updated.id, name: updated.name });
    return res.json({ ok: true, product: updated });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message || "Could not restore product" });
  }
});

app.patch("/api/admin/products/:id", requireAdmin, validateBody(schemas.adminProductStatusPatch), async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const id = String(req.params.id || "").trim();
    const sourcing_status = String(req.validatedBody?.sourcing_status || "").toLowerCase();
    if (!id || !["draft", "approved", "rejected"].includes(sourcing_status)) {
      return res.status(400).json({ ok: false, error: "Invalid id or sourcing_status" });
    }
    const { data: before } = await supabase
      .from("products")
      .select("id, status, sourcing_status")
      .eq("id", id)
      .maybeSingle();
    const row = { sourcing_status, updated_at: new Date().toISOString() };
    /* Godkendelse = synlig på shop: sæt aktiv livscyklus-status (fx efter CEO «scaling»). */
    if (sourcing_status === "approved") row.status = "active";
    const { data, error } = await supabase
      .from("products")
      .update(row)
      .eq("id", id)
      .neq("status", "removed")
      .select("id, name, sourcing_status, status")
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, error: "Product not found" });
    await logProductTransition(supabase, {
      product_id: data.id,
      from_status: before?.status || null,
      to_status: data.status || null,
      from_sourcing: before?.sourcing_status || null,
      to_sourcing: data.sourcing_status || null,
      reason: "admin_sourcing_status_update",
      actor_type: "admin",
      actor_id: "dashboard",
    });
    res.json({ ok: true, product: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Could not update product" });
  }
});

app.post("/api/admin/products/:id/reimport", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const { data: p, error: fetchErr } = await supabase.from("products").select("*").eq("id", id).single();
    if (fetchErr || !p || p.status === "removed") {
      return res.status(404).json({ ok: false, error: "Product not found" });
    }
    const raw = {
      title: p.name,
      price: Number(p.cost) || Number(p.price) || 0,
      image: p.image_url || "",
      externalId: p.external_id || p.source_product_id || id,
      category: p.category,
      color: p.color,
    };
    const sourceMeta = {
      sourcePlatform: p.source_platform || "",
      sourceName: p.source_name || "",
      sourceUrl: p.source_url || "",
      sourceProductId: p.source_product_id || p.external_id || "",
      supplierName: p.supplier_name || "",
      supplierCountry: p.supplier_country || "",
      importMethod: p.import_method || "",
    };
    const ev = await evaluateVeldenSourcing(raw, sourceMeta);
    const row = {
      name: ev.title.slice(0, 200),
      category: ev.category,
      description: ev.description || p.description,
      image_url: ev.image || p.image_url,
      sourcing_status: ev.status,
      ai_fit_score: ev.aiScore,
      brand_fit_reason: ev.brandFitReason || "",
      source_platform: ev.sourcePlatform || p.source_platform,
      source_name: ev.sourceName || p.source_name,
      source_url: ev.sourceUrl || p.source_url,
      source_product_id: ev.sourceProductId || p.source_product_id,
      supplier_name: ev.supplierName || p.supplier_name,
      supplier_country: ev.supplierCountry || p.supplier_country,
      import_method: ev.importMethod || p.import_method,
      updated_at: new Date().toISOString(),
    };
    const { data: updated, error: upErr } = await supabase
      .from("products")
      .update(row)
      .eq("id", id)
      .select("id, name, sourcing_status, ai_fit_score")
      .single();
    if (upErr) throw upErr;
    res.json({
      ok: true,
      product: updated,
      evaluation: ev,
      meta: apiOnlyMeta("/api/admin/products/:id/reimport"),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Re-import failed" });
  }
});

function seoOptimizationTextSnapshot(row) {
  const r = row || {};
  return {
    name: String(r.name ?? ""),
    description: String(r.description ?? ""),
    selling_points: String(r.selling_points ?? ""),
    seo_meta_title: String(r.seo_meta_title ?? ""),
    seo_meta_description: String(r.seo_meta_description ?? ""),
  };
}

function normalizeAiLogDetailsPayload(raw) {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      return p && typeof p === "object" ? p : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? raw : {};
}

/** Virker selv gamle DB’er mangler seo_meta_* eller seo_last_checked_at (én kolonne fejler hele select). */
async function loadProductRowForSeoChangelog(supabase, id) {
  const tries = [
    "id, name, description, selling_points, seo_meta_title, seo_meta_description, seo_last_checked_at",
    "id, name, description, selling_points, seo_last_checked_at",
    "id, name, description, selling_points",
  ];
  for (const sel of tries) {
    const { data, error } = await supabase.from("products").select(sel).eq("id", id).maybeSingle();
    if (!error && data) {
      return {
        id: data.id,
        name: data.name,
        description: data.description,
        selling_points: data.selling_points,
        seo_meta_title: data.seo_meta_title != null ? String(data.seo_meta_title) : "",
        seo_meta_description: data.seo_meta_description != null ? String(data.seo_meta_description) : "",
        seo_last_checked_at: data.seo_last_checked_at != null ? data.seo_last_checked_at : null,
      };
    }
  }
  return null;
}

async function runSeoOptimizeForProductId(res, idRaw) {
  if (!supabase) return dbUnavailable(res);
  const id = String(idRaw || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
  const checkedAt = new Date().toISOString();
  const { data: p, error } = await supabase.from("products").select("*").eq("id", id).single();
  if (error || !p || p.status === "removed") {
    return res.status(404).json({ ok: false, error: "Product not found" });
  }
  const beforeSnapshot = seoOptimizationTextSnapshot(p);
  const seo = await optimizeProductSeoDanish(p);
  const rowFull = {
    name: seo.name,
    description: seo.description,
    selling_points: seo.selling_points,
    seo_meta_title: seo.seo_meta_title,
    seo_meta_description: seo.seo_meta_description,
    seo_last_checked_at: checkedAt,
    updated_at: checkedAt,
  };
  const { data: updated, error: upErr } = await supabase
    .from("products")
    .update(rowFull)
    .eq("id", id)
    .select("id, name, description, selling_points, seo_meta_title, seo_meta_description, seo_last_checked_at")
    .single();
  if (upErr) {
    const rowNoMeta = {
      name: seo.name,
      description: seo.description,
      selling_points: seo.selling_points,
      seo_last_checked_at: checkedAt,
      updated_at: checkedAt,
    };
    let { data: u2, error: e2 } = await supabase
      .from("products")
      .update(rowNoMeta)
      .eq("id", id)
      .select("id, name, description, selling_points, seo_last_checked_at")
      .single();
    if (e2) {
      ({ data: u2, error: e2 } = await supabase
        .from("products")
        .update({
          name: seo.name,
          description: seo.description,
          selling_points: seo.selling_points,
          updated_at: checkedAt,
        })
        .eq("id", id)
        .select("id, name, description, selling_points")
        .single());
    }
    if (e2) throw e2;
    const noteParts = ["Kør supabase/migrate_product_seo_meta.sql for seo_meta_* kolonner"];
    if (!u2.seo_last_checked_at) noteParts.push("Kør migrate_seo_last_checked_at.sql for 15-dages SEO-logik");
    await logAiToSupabase("product_seo_optimized", {
      id: u2.id,
      name: u2.name,
      checkedAt,
      before: beforeSnapshot,
      after: seoOptimizationTextSnapshot(u2),
      note: noteParts.join(" · "),
    });
    return res.json({
      ok: true,
      product: u2,
      warning: noteParts.join(" "),
    });
  }
  await logAiToSupabase("product_seo_optimized", {
    id: updated.id,
    name: updated.name,
    checkedAt,
    before: beforeSnapshot,
    after: seoOptimizationTextSnapshot(updated),
  });
  return res.json({ ok: true, product: updated });
}

/** Body: `{ "productId": "<uuid>" }` — samme som POST …/products/:id/seo-optimize (nemmere for nogle proxies). */
app.post("/api/admin/seo/run", requireAdmin, validateBody(schemas.adminSeoRun), async (req, res) => {
  try {
    const id = String(req.validatedBody?.productId || req.validatedBody?.id || "").trim();
    await runSeoOptimizeForProductId(res, id);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "SEO update failed" });
  }
});

app.post("/api/admin/products/:id/seo-optimize", requireAdmin, async (req, res) => {
  try {
    await runSeoOptimizeForProductId(res, req.params.id);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "SEO update failed" });
  }
});

/** Seneste SEO før/efter fra ai_log (til popup i admin). */
app.get("/api/admin/products/:id/seo-changelog", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const product = await loadProductRowForSeoChangelog(supabase, id);
    if (!product) return res.status(404).json({ ok: false, error: "Product not found" });

    let q = await supabase
      .from("ai_log")
      .select("action, details, created_at")
      .eq("action", "product_seo_optimized")
      .order("created_at", { ascending: false })
      .limit(500);
    if (q.error) throw q.error;

    let lastOptimization = null;
    for (const row of q.data || []) {
      const d = normalizeAiLogDetailsPayload(row.details);
      const rid = String(d.id || d.product_id || d.productId || "").trim();
      if (rid !== id) continue;
      lastOptimization = {
        createdAt: row.created_at || null,
        checkedAt: d.checkedAt || null,
        before: d.before && typeof d.before === "object" ? d.before : null,
        after: d.after && typeof d.after === "object" ? d.after : null,
        note: typeof d.note === "string" ? d.note : null,
      };
      break;
    }

    return res.json({ ok: true, product, lastOptimization });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** In-memory automation only — billigt poll til live motorstatus i admin (ingen DB). */
function automationPayload() {
  const auto = getAutomationState();
  return {
    status: auto.running ? "running" : "idle",
    running: auto.running,
    ceoPaused: Boolean(auto.ceoAutomationPaused),
    lastRunAt: auto.lastRunAt,
    lastError: auto.lastError,
    productsAddedLastRun: auto.productsAddedLastRun,
    productsRemovedLastRun: auto.productsRemovedLastRun,
    performanceSummary: auto.performanceSummary,
    decisionsLastRun: auto.decisionsLastRun,
    nextIntervalHours: auto.nextIntervalMs / 3600000,
    nextIntervalMinutes: auto.nextIntervalMs / 60000,
    lastPlan: auto.lastPlan,
    sourcingRunning: auto.sourcingRunning,
    sourcingLastRunAt: auto.sourcingLastRunAt,
    sourcingLastInserted: auto.sourcingLastInserted,
    sourcingLastError: auto.sourcingLastError,
    sourcingLastDiscovery: auto.sourcingLastDiscovery || null,
    sourcingIntervalMinutes: auto.sourcingIntervalMs / 60000,
    /** ms — same as env SOURCING_INTERVAL_MS (shown on admin dashboard) */
    sourcingIntervalMs: auto.sourcingIntervalMs,
  };
}

app.get("/api/admin/pulse", (_req, res) => {
  res.json({
    ok: true,
    ai: automationPayload(),
    serverTime: new Date().toISOString(),
  });
});

app.get("/api/admin/store-config", requireAdmin, async (_req, res) => {
  try {
    const raw = await getStoreConfig(supabase);
    res.json({ ok: true, status: "ok", config: sanitizeStoreConfigForClient(raw) });
  } catch (e) {
    res.status(500).json({ ok: false, status: "error", reason: "degraded_system", error: String(e.message || e) });
  }
});

/** Leverandør-adgang: web-seeds, Shopify JSON, eBay OAuth+Browse (nøgler fra store_config), m.m. */
app.get("/api/admin/sourcing-health", requireAdmin, async (_req, res) => {
  try {
    const raw = await getStoreConfig(supabase);
    const health = await runSourcingHealthChecks(raw);
    res.json({ ok: true, status: "ok", health });
  } catch (e) {
    res.status(500).json({ ok: false, status: "error", reason: "degraded_system", error: String(e.message || e) });
  }
});

/** eBay (manual) fulfillment inbox — Shopify stays automatic via supplier webhooks in processOrderFulfillment. */
app.get("/api/admin/fulfillment-queue", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const out = await listFulfillmentQueueWithPriority(supabase, { status: req.query.status });
    res.json({ ok: true, items: out.items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/admin/fulfillment-queue/:id/complete", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const id = String(req.params.id || "").trim();
    const result = await markFulfillmentQueueCompleted(supabase, id);
    if (!result.ok) {
      return res.status(404).json({ ok: false, error: result.error || "Not updated" });
    }
    res.json({ ok: true, id: result.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** Butikstyper + kategori-labels til admin (samme kilde som store-taxonomy.js). */
app.get("/api/admin/category-taxonomy", requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    verticals: STORE_VERTICALS,
    allCategoryIds: TAXONOMY_ALL_CATEGORY_IDS,
    labels: TAXONOMY_LABELS_DA,
  });
});

app.post("/api/admin/store-config", requireAdmin, validateBody(schemas.adminStoreConfig), async (req, res) => {
  try {
    const patch = req.validatedBody?.config || req.validatedBody || {};
    const result = await updateStoreConfig(supabase, patch);
    if (result && result.status === "error") {
      return res.status(400).json({
        ok: false,
        status: "error",
        reason: result.reason || "invalid_config",
        issues: result.issues || [],
      });
    }
    res.json({ ok: true, status: "ok", reason: null, config: sanitizeStoreConfigForClient(result) });
  } catch (e) {
    res.status(500).json({ ok: false, status: "error", reason: "degraded_system", error: String(e.message || e) });
  }
});

app.post("/api/admin/automation/ceo-pause", requireAdmin, validateBody(schemas.adminCeoPause), async (req, res) => {
  try {
    const p = req.validatedBody?.paused;
    if (typeof p !== "boolean") {
      return res.status(400).json({ ok: false, error: "Body skal indeholde paused: true eller false (JSON)." });
    }
    setCeoAutomationPaused(p);
    await logAiToSupabase("admin_ceo_automation_pause", { paused: p });
    res.json({ ok: true, ceoPaused: p });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

app.post("/api/admin/fill-shop", requireAdmin, validateBody(schemas.adminFillShop), async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const body = req.validatedBody || {};
    const result = await autoFillShopToMax(supabase, {
      dryRun: Boolean(body.dryRun),
      maxCycles: body.maxCycles,
      perCycleLimit: body.perCycleLimit,
      cooldownMs: body.cooldownMs,
    });
    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        status: "error",
        reason: "degraded_system",
        discovery: result.discovery || null,
        error: result.error || "Could not fill shop",
      });
    }
    obsLogger.info("admin.fill_shop.completed", obsLogger.fromRequest(req, {
      dryRun: Boolean(body.dryRun),
      reachedMax: result.reachedMax,
      activeCount: result.activeCount,
      cap: result.cap,
      cycles: (result.progress || []).length,
    }));
    return res.json({
      ok: true,
      status: result.insertedTotal > 0 ? "ok" : "no_data",
      reason: null,
      ...result,
      meta: apiOnlyMeta("/api/admin/fill-shop", ["/api/admin/fill-shop/dry-run"]),
    });
  } catch (e) {
    obsLogger.error("admin.fill_shop.failed", obsLogger.fromRequest(req, { error: e.message || String(e) }));
    return res.status(500).json({ ok: false, status: "error", reason: "degraded_system", error: String(e.message || e) });
  }
});

app.post("/api/admin/fill-shop/dry-run", requireAdmin, validateBody(schemas.adminFillShop), async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const body = req.validatedBody || {};
    const result = await autoFillShopToMax(supabase, {
      dryRun: true,
      maxCycles: body.maxCycles,
      perCycleLimit: body.perCycleLimit,
      cooldownMs: body.cooldownMs,
    });
    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        status: "error",
        reason: "degraded_system",
        discovery: result.discovery || null,
        error: result.error || "Could not run dry-run",
      });
    }
    obsLogger.info(
      "admin.fill_shop.dry_run.completed",
      obsLogger.fromRequest(req, {
        totalFound: result.totalFound,
        wouldInsert: result.wouldInsert,
        cap: result.cap,
      })
    );
    return res.json({
      ok: true,
      status: Number(result.wouldInsertCount) > 0 ? "ok" : "no_data",
      reason: (result.discovery && result.discovery.reason) || null,
      counts:
        result.counts || {
          totalFound: Number(result.totalFound) || 0,
          afterFiltering: Number(result.afterFiltering) || 0,
          rejectedCount: Number(result.rejectedCount) || 0,
          wouldInsertCount: Number(result.wouldInsertCount) || 0,
        },
      ...result,
      meta: apiOnlyMeta("/api/admin/fill-shop/dry-run", ["/api/admin/fill-shop"]),
    });
  } catch (e) {
    obsLogger.error("admin.fill_shop.dry_run.failed", obsLogger.fromRequest(req, { error: e.message || String(e) }));
    return res.status(500).json({ ok: false, status: "error", reason: "degraded_system", error: String(e.message || e) });
  }
});

app.post("/api/admin/run-ai-ceo", requireAdmin, validateBody(schemas.adminRunAiCeo), async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const body = req.validatedBody || {};
    const out = await runAiCeoCycle({
      supabase,
      dryRun: Boolean(body.dryRun),
      mode: body.mode || "full",
    });
    if (!out || out.ok === false) {
      return res.status(400).json({
        ok: false,
        status: "error",
        reason: "degraded_system",
        error: (out && out.error) || "AI CEO cycle failed",
      });
    }
    return res.json({
      ok: true,
      status: out.status || "ok",
      reason: null,
      source: "delegated-automation",
      mode: out.mode,
      dryRun: out.dryRun,
      version: out.version || null,
      summary: out.summary || {},
      errors: Array.isArray(out.errors) ? out.errors : [],
    });
  } catch (e) {
    return res.status(500).json({ ok: false, status: "error", reason: "degraded_system", error: String(e.message || e) });
  }
});

app.get("/api/admin/ai-ceo/last-run", requireAdmin, async (_req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const { data, error } = await supabase
      .from("ai_ceo_runs")
      .select("mode,summary,created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      return res.json({
        ok: true,
        lastRun: null,
        meta: apiOnlyMeta("/api/admin/ai-ceo/last-run", ["/api/admin/ai-ceo/last-run/pretty"]),
      });
    }
    return res.json({
      ok: true,
      lastRun: data || null,
      meta: apiOnlyMeta("/api/admin/ai-ceo/last-run", ["/api/admin/ai-ceo/last-run/pretty"]),
    });
  } catch {
    return res.json({
      ok: true,
      lastRun: null,
      meta: apiOnlyMeta("/api/admin/ai-ceo/last-run", ["/api/admin/ai-ceo/last-run/pretty"]),
    });
  }
});

app.get("/api/admin/ai-ceo/runs", requireAdmin, async (_req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const { data, error } = await supabase
      .from("ai_ceo_runs")
      .select("mode,summary,created_at")
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) return res.json({ ok: true, runs: [] });
    return res.json({ ok: true, runs: data || [] });
  } catch {
    return res.json({ ok: true, runs: [] });
  }
});

app.get("/api/admin/orders/fulfillment", requireAdmin, async (_req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const { data, error } = await supabase
      .from("orders")
      .select("id,status,customer_email,amount_cents,currency,created_at,supplier_data")
      .order("created_at", { ascending: false })
      .limit(40);
    if (error) throw error;
    const rows = (data || []).map((o) => {
      const supplier = o && typeof o.supplier_data === "object" && o.supplier_data ? o.supplier_data : {};
      const f = supplier && typeof supplier.fulfillment === "object" && supplier.fulfillment ? supplier.fulfillment : {};
      return {
        id: o.id,
        orderStatus: o.status || "unknown",
        customerEmail: o.customer_email || "",
        amountCents: Number(o.amount_cents) || 0,
        currency: o.currency || "usd",
        createdAt: o.created_at || null,
        fulfillment: {
          status: f.status || "pending",
          updatedAt: f.updatedAt || null,
          lastAttemptAt: f.lastAttemptAt || null,
          lastError: f.lastError || null,
          runs: Array.isArray(f.runs) ? f.runs.slice(0, 8) : [],
        },
      };
    });
    return res.json({ ok: true, orders: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/admin/marketing/status", requireAdmin, async (_req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const status = await getMarketingStatus(supabase);
    return res.json({ ok: true, ...status });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/admin/marketing/connections", requireAdmin, async (_req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const rows = await listConnections(supabase, "active");
    const safe = (rows || []).map((r) => ({
      platform: r.platform,
      enabled: r.enabled !== false,
      connected: Boolean(String(r.access_token_enc || "").trim()),
      authMethod: r.auth_method || "",
      connectedAt: r.connected_at || "",
      accountId: r.account_id || "",
      pageId: r.page_id || "",
      igUserId: r.ig_user_id || "",
      expiresAt: r.expires_at || null,
      hasRefreshToken: Boolean(String(r.refresh_token_enc || "").trim()),
    }));
    return res.json({ ok: true, connections: safe });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/admin/marketing/connect", requireAdmin, validateBody(schemas.adminMarketingConnect), async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const body = req.validatedBody || {};
    const out = await connectPlatform(supabase, body.platform, body.token, {
      pageId: body.pageId,
      igUserId: body.igUserId,
      accountId: body.accountId,
      authMethod: "manual",
    });
    if (!out.ok) return res.status(400).json({ ok: false, error: out.error || "Connect failed" });
    return res.json({
      ok: true,
      marketing: out.marketing,
      meta: apiOnlyMeta("/api/admin/marketing/connect", [
        "/api/admin/marketing/oauth/:platform/authorize-url",
        "/api/admin/marketing/oauth/:platform/authorize",
      ]),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/admin/marketing/disconnect", requireAdmin, validateBody(schemas.adminMarketingDisconnect), async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const body = req.validatedBody || {};
    const out = await disconnectPlatform(supabase, body.platform);
    if (!out.ok) return res.status(400).json({ ok: false, error: out.error || "Disconnect failed" });
    return res.json({ ok: true, marketing: out.marketing });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post(
  "/api/admin/marketing/backfill-connections",
  requireAdmin,
  validateBody(schemas.adminMarketingBackfillConnections),
  async (req, res) => {
    try {
      if (!supabase) return dbUnavailable(res);
      const body = req.validatedBody || {};
      const out = await backfillMarketingConnectionsFromStoreConfig(supabase, {
        dryRun: body.dryRun === true,
        clearLegacyTokens: body.clearLegacyTokens !== false,
      });
      if (!out.ok) return res.status(400).json({ ok: false, error: out.error || "backfill_failed" });
      return res.json({ ok: true, backfill: out });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }
);

app.get("/api/admin/marketing/oauth/:platform/authorize", requireAdmin, async (req, res) => {
  try {
    const built = await buildMarketingAuthorizeUrl(req.params.platform);
    if (!built.ok) return res.status(400).json({ ok: false, error: built.error || "Unsupported platform" });
    return res.redirect(302, built.url);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/admin/marketing/oauth/:platform/authorize-url", requireAdmin, async (req, res) => {
  try {
    const built = await buildMarketingAuthorizeUrl(req.params.platform);
    if (!built.ok) return res.status(400).json({ ok: false, error: built.error || "Unsupported platform" });
    return res.json({ ok: true, url: built.url, platform: built.platform });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Backward-compatible aliases for older frontend builds.
app.get("/api/admin/marketing/oauth/:platform/start", requireAdmin, async (req, res) => {
  try {
    const built = await buildMarketingAuthorizeUrl(req.params.platform);
    if (!built.ok) return res.status(400).json({ ok: false, error: built.error || "Unsupported platform" });
    res.setHeader("X-Deprecated-Route", "/api/admin/marketing/oauth/:platform/start");
    res.setHeader("Link", '</api/admin/marketing/oauth/:platform/authorize>; rel="successor-version"');
    return res.redirect(302, built.url);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/admin/marketing/oauth/:platform/url", requireAdmin, async (req, res) => {
  try {
    const built = await buildMarketingAuthorizeUrl(req.params.platform);
    if (!built.ok) return res.status(400).json({ ok: false, error: built.error || "Unsupported platform" });
    res.setHeader("X-Deprecated-Route", "/api/admin/marketing/oauth/:platform/url");
    res.setHeader("Link", '</api/admin/marketing/oauth/:platform/authorize-url>; rel="successor-version"');
    return res.json({
      ok: true,
      url: built.url,
      platform: built.platform,
      meta: { deprecated: true, canonical: "/api/admin/marketing/oauth/:platform/authorize-url" },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/admin/marketing/oauth/:platform/callback", async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const platform = String(req.params.platform || "").toLowerCase();
    const state = String(req.query.state || "");
    const code = String(req.query.code || "");
    const oauthErr = String(req.query.error || "");
    if (oauthErr) {
      return res.redirect(302, "/admin/marketing?oauth=error&reason=" + encodeURIComponent(oauthErr));
    }
    const stored = await consumeOauthState(supabase, state);
    if (!stored || String(stored.platform || "") !== platform) {
      return res.redirect(302, "/admin/marketing?oauth=error&reason=invalid_state");
    }
    if (!code) {
      return res.redirect(302, "/admin/marketing?oauth=error&reason=missing_code");
    }

    if (platform === "facebook" || platform === "instagram") {
      const tokenOut = await exchangeFacebookCode({ code, platform });
      if (!tokenOut.ok) {
        return res.redirect(302, "/admin/marketing?oauth=error&reason=" + encodeURIComponent(tokenOut.error || "token_exchange_failed"));
      }
      const c = await connectPlatform(supabase, platform, tokenOut.token, {
        pageId: tokenOut.pageId || "",
        igUserId: tokenOut.igUserId || "",
        authMethod: "oauth",
        expiresAt: tokenOut.expiresIn ? new Date(Date.now() + Number(tokenOut.expiresIn) * 1000).toISOString() : null,
      });
      if (!c.ok) {
        return res.redirect(302, "/admin/marketing?oauth=error&reason=" + encodeURIComponent(c.error || "connect_failed"));
      }
      return res.redirect(302, "/admin/marketing?oauth=ok&platform=" + encodeURIComponent(platform));
    }

    if (platform === "tiktok") {
      const tokenOut = await exchangeTikTokCode({ code });
      if (!tokenOut.ok) {
        return res.redirect(302, "/admin/marketing?oauth=error&reason=" + encodeURIComponent(tokenOut.error || "token_exchange_failed"));
      }
      const c = await connectPlatform(supabase, platform, tokenOut.token, {
        accountId: tokenOut.accountId || "",
        authMethod: "oauth",
        refreshToken: tokenOut.refreshToken || "",
        expiresAt: tokenOut.expiresIn ? new Date(Date.now() + Number(tokenOut.expiresIn) * 1000).toISOString() : null,
      });
      if (!c.ok) {
        return res.redirect(302, "/admin/marketing?oauth=error&reason=" + encodeURIComponent(c.error || "connect_failed"));
      }
      return res.redirect(302, "/admin/marketing?oauth=ok&platform=tiktok");
    }

    return res.redirect(302, "/admin/marketing?oauth=error&reason=unsupported_platform");
  } catch (e) {
    return res.redirect(302, "/admin/marketing?oauth=error&reason=" + encodeURIComponent(String(e.message || e)));
  }
});

app.post("/api/admin/marketing/toggle", requireAdmin, validateBody(schemas.adminMarketingToggle), async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const body = req.validatedBody || {};
    const out = await togglePlatform(supabase, body.platform, body.enabled);
    if (!out.ok) return res.status(400).json({ ok: false, error: out.error || "Toggle failed" });
    return res.json({ ok: true, marketing: out.marketing });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/admin/marketing/settings", requireAdmin, validateBody(schemas.adminMarketingSettings), async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const out = await updateMarketingSettings(supabase, req.validatedBody || {});
    return res.json({ ok: true, marketing: out.marketing });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/admin/marketing/test-post", requireAdmin, validateBody(schemas.adminMarketingTestPost), async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const out = await testPost(supabase, req.validatedBody || {});
    if (!out.ok) return res.status(400).json({ ok: false, error: out.error || "Test post failed" });
    return res.json({ ok: true, preview: out.preview, content: out.content });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/admin/marketing/post-now", requireAdmin, validateBody(schemas.adminMarketingPostNow), async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const out = await postNowForPlatform(supabase, req.validatedBody || {});
    if (!out.ok) return res.status(400).json({ ok: false, error: out.error || "Post failed" });
    return res.json({ ok: true, post: out.post, content: out.content, result: out.result || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/admin/marketing/posts", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const posts = await listPosts(supabase, Number(req.query.limit) || 30);
    return res.json({ ok: true, posts });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/admin/marketing/post-products", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const products = await listPostableProducts(supabase, Number(req.query.limit) || 80);
    return res.json({ ok: true, products });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

function aiCeoPrettyReport(lastRun, prevRun = null) {
  if (!lastRun || !lastRun.summary || typeof lastRun.summary !== "object") return null;
  const s = lastRun.summary || {};
  const removed = Number(s.removedCount) || 0;
  const added = Number(s.addedCount) || 0;
  const priceChanges = Number(s.priceChanges) || 0;
  const errors = Array.isArray(s.errors) ? s.errors.length : Number(s.errors) || 0;

  const growthFocus = added > removed;
  const cleanupFocus = removed > added;
  let headline = "AI updated your store";
  if (growthFocus) headline = "AI grew your catalog";
  else if (cleanupFocus) headline = "AI cleaned up your catalog";

  let summary = `Removed ${removed} low-performing products, added ${added} new ones`;
  if (priceChanges > 0) summary += `, and adjusted prices on ${priceChanges} items.`;
  else summary += ".";

  let insight = growthFocus
    ? "Catalog growth was prioritized while preserving quality filters."
    : cleanupFocus
      ? "Catalog quality was tightened by removing weak performers."
      : "Catalog balance was maintained with a steady optimization pass.";
  if (priceChanges > 0) insight += " Pricing optimization was applied to improve conversion/revenue.";

  const risk = errors > 0 ? "medium" : "low";

  let performance = "stable";
  if (prevRun && prevRun.summary && typeof prevRun.summary === "object") {
    const p = prevRun.summary || {};
    const currScore = (added - removed) + (priceChanges > 0 ? 1 : 0) - (errors > 0 ? 1 : 0);
    const prevScore =
      ((Number(p.addedCount) || 0) - (Number(p.removedCount) || 0)) +
      ((Number(p.priceChanges) || 0) > 0 ? 1 : 0) -
      ((Array.isArray(p.errors) ? p.errors.length : Number(p.errors) || 0) > 0 ? 1 : 0);
    performance = currScore > prevScore ? "improving" : currScore < prevScore ? "declining" : "stable";
  } else {
    performance = errors > 0 ? "stable" : added >= removed ? "improving" : "stable";
  }

  return { headline, summary, insight, risk, performance };
}

app.get("/api/admin/ai-ceo/last-run/pretty", requireAdmin, async (_req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const { data, error } = await supabase
      .from("ai_ceo_runs")
      .select("mode,summary,created_at")
      .order("created_at", { ascending: false })
      .limit(2);
    if (error || !Array.isArray(data) || !data.length) {
      return res.json({ ok: true, report: null });
    }
    const report = aiCeoPrettyReport(data[0], data[1] || null);
    return res.json({ ok: true, report: report || null });
  } catch {
    return res.json({ ok: true, report: null });
  }
});

app.post("/api/admin/products/purge-all", requireAdmin, validateBody(schemas.adminPurgeAll), async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const confirm = String(req.validatedBody?.confirm || "").trim();
    if (confirm !== "SLET_ALLE_PRODUKTER") {
      return res.status(400).json({
        ok: false,
        error: 'Bekræft med JSON { "confirm": "SLET_ALLE_PRODUKTER" } (præcis tekst).',
      });
    }
    async function deleteSatelliteRowsForProducts(ids) {
      if (!ids.length) return;
      const tables = ["price_elasticity", "product_state_transitions"];
      for (const table of tables) {
        const { error } = await supabase.from(table).delete().in("product_id", ids);
        if (error && !/does not exist|Could not find the table|schema cache/i.test(String(error.message))) {
          logger.warn("admin.purge.satellite_delete", { table, message: error.message });
        }
      }
    }
    let total = 0;
    for (;;) {
      const { data, error } = await supabase.from("products").select("id").limit(500);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      if (!data || !data.length) break;
      const ids = data.map((r) => r.id);
      await deleteSatelliteRowsForProducts(ids);
      const { error: delErr } = await supabase.from("products").delete().in("id", ids);
      if (delErr) return res.status(500).json({ ok: false, error: delErr.message });
      total += ids.length;
      if (data.length < 500) break;
    }
    await logAiToSupabase("admin_purge_all_products", { deleted: total });
    res.json({ ok: true, deleted: total });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

app.post("/api/admin/import/shopify", requireAdmin, validateBody(schemas.adminShopifyImport), async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const shopUrl = String(req.validatedBody?.shopUrl || req.validatedBody?.url || "").trim();
    if (!shopUrl) return res.status(400).json({ ok: false, error: "shopUrl er påkrævet (butiks-URL eller /collections/handle, https://…)." });
    const forceCategoryRaw = String(req.validatedBody?.forceCategory || "").trim();
    const chRaw = req.validatedBody?.collectionHandle != null ? String(req.validatedBody.collectionHandle).trim() : "";
    const loaded = await loadShopifyProductRows(shopUrl, {
      forceCategory: forceCategoryRaw || undefined,
      collectionHandle: chRaw || undefined,
    });
    if (!loaded.ok) return res.status(400).json({ ok: false, error: loaded.error });
    const batch = await insertProvenanceProductsBatch(supabase, loaded.rows, {
      logAction: "shopify_import_row",
      logExtra: { shopOrigin: loaded.origin, collection: loaded.collectionHandle },
    });
    await logAiToSupabase("admin_shopify_import_complete", {
      origin: loaded.origin,
      collection: loaded.collectionHandle,
      inserted: batch.inserted,
      merged: batch.merged,
      skipped: batch.skipped,
      errorSample: (batch.errors || []).slice(0, 15),
    });
    res.json({
      ok: true,
      origin: loaded.origin,
      collection: loaded.collectionHandle,
      fetched: loaded.productCount,
      inserted: batch.inserted,
      merged: batch.merged,
      skipped: batch.skipped,
      errors: (batch.errors || []).slice(0, 25),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

app.get("/api/admin/sourcing-candidates", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const limit = Number(req.query.limit) || 100;
    const rows = await listPendingSourcingCandidates(supabase, limit);
    return res.json({ ok: true, candidates: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post(
  "/api/admin/sourcing-candidates/:id/approve",
  requireAdmin,
  validateBody(schemas.adminSourcingCandidateDecision),
  async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Invalid candidate id" });

    const { data: candidate, error } = await supabase
      .from("sourcing_candidates")
      .select("*")
      .eq("id", id)
      .eq("status", "pending")
      .maybeSingle();
    if (error) throw error;
    if (!candidate) return res.status(404).json({ ok: false, error: "Candidate not found or already processed" });

    const row = candidate.candidate_payload && candidate.candidate_payload.row;
    if (!row || typeof row !== "object") {
      return res.status(400).json({ ok: false, error: "Candidate payload is missing row data" });
    }

    const batch = await insertProvenanceProductsBatch(supabase, [row], {
      logAction: "sourcing_candidate_approved",
      logExtra: { candidate_id: id, approved_via: "admin_review_queue" },
      forcePublish: true,
    });
    if ((batch.inserted || 0) + (batch.merged || 0) <= 0) {
      return res.status(409).json({ ok: false, error: "Could not publish candidate", details: batch.errors || [] });
    }

    const up = await updateSourcingCandidateDecision(supabase, id, {
      status: "approved",
      reason: String(req.validatedBody?.reason || "Approved by admin"),
    });
    if (!up.ok) return res.status(500).json({ ok: false, error: up.error || "Could not update candidate status" });
    obsLogger.info("sourcing.candidate.approved", obsLogger.fromRequest(req, { candidateId: id, reason: up.candidate?.decision_reason || "" }));

    return res.json({ ok: true, candidate: up.candidate, publishResult: batch });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
  }
);

app.post(
  "/api/admin/sourcing-candidates/:id/reject",
  requireAdmin,
  validateBody(schemas.adminSourcingCandidateDecision),
  async (req, res) => {
  try {
    if (!supabase) return dbUnavailable(res);
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Invalid candidate id" });
    const up = await updateSourcingCandidateDecision(supabase, id, {
      status: "rejected",
      reason: String(req.validatedBody?.reason || "Rejected by admin"),
    });
    if (!up.ok) return res.status(500).json({ ok: false, error: up.error || "Could not update candidate status" });
    obsLogger.info("sourcing.candidate.rejected", obsLogger.fromRequest(req, { candidateId: id, reason: up.candidate?.decision_reason || "" }));
    return res.json({ ok: true, candidate: up.candidate });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
  }
);

app.get("/api/admin/summary", requireAdmin, async (_req, res) => {
  try {
    let recentLogs = [];
    let productCount = 0;
    let removedCount = 0;
    let draftSkus = 0;
    let catalogRows = [];
    let catalogMetrics = { totalViews: 0, totalClicks: 0, totalOrders: 0 };
    let variantMetrics = {
      A: { count: 0, orders: 0, revenue: 0 },
      B: { count: 0, orders: 0, revenue: 0 },
      none: { count: 0, orders: 0, revenue: 0 },
    };
    let storeMetrics = {
      totalRevenue: 0,
      totalProfit: 0,
      avgMargin: 0,
      avgConversionRate: 0,
      AOV: 0,
    };
    let trends7d = [];
    let learningMetrics = {
      profit_per_sku: 0,
      learning_velocity: { last7d: 0, last30d: 0 },
      explore_vs_exploit: {},
      decision_accuracy: 0,
      fallback_performance: {},
      series: [],
    };

    if (supabase) {
      const qNew = await supabase
        .from("ai_log")
        .select("action, created_at, details")
        .order("created_at", { ascending: false })
        .limit(50);
      if (!qNew.error) recentLogs = qNew.data || [];

      const { count: shopVisible } = await visibleOnShopfront(
        supabase.from("products").select("id", { count: "exact", head: true })
      ).neq("status", "removed");
      productCount = shopVisible ?? 0;

      const { count: draftsN } = await supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("sourcing_status", "draft")
        .neq("status", "removed");
      draftSkus = draftsN ?? 0;

      const { count: rem } = await supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("status", "removed");
      removedCount = rem ?? 0;

      const { data: metricRows } = await visibleOnShopfront(
        supabase.from("products").select("views, clicks, orders_count")
      ).neq("status", "removed");
      const { data: storeRows } = await visibleOnShopfront(
        supabase.from("products").select("id, price, cost, views, orders_count, experiment_variant")
      ).neq("status", "removed");

      const catSelectFull =
        "id, name, category, price, status, sourcing_status, source_platform, source_name, source_url, source_product_id, external_id, image_url, available, availability_reason, supplier_last_checked_at, supplier_sync_error, supplier_name, supplier_country, import_method, ai_fit_score, brand_fit_reason, updated_at, color, style_key, seo_last_checked_at";
      const catSelectLite =
        "id, name, category, price, status, sourcing_status, source_platform, source_name, source_url, source_product_id, external_id, image_url, available, availability_reason, supplier_last_checked_at, supplier_sync_error, supplier_name, supplier_country, import_method, ai_fit_score, brand_fit_reason, updated_at, color, style_key";
      const catSelectLegacy =
        "id, name, category, price, status, sourcing_status, source_platform, source_name, source_url, source_product_id, external_id, image_url, available, availability_reason, supplier_last_checked_at, supplier_sync_error, supplier_name, supplier_country, import_method, ai_fit_score, brand_fit_reason, updated_at";
      let catQActive = await supabase
        .from("products")
        .select(catSelectFull)
        .neq("status", "removed")
        .order("updated_at", { ascending: false })
        .limit(120);
      let catQRemoved = await supabase
        .from("products")
        .select(catSelectFull)
        .eq("status", "removed")
        .order("updated_at", { ascending: false })
        .limit(80);
      if (catQActive.error) {
        catQActive = await supabase
          .from("products")
          .select(catSelectLite)
          .neq("status", "removed")
          .order("updated_at", { ascending: false })
          .limit(120);
      }
      if (catQRemoved.error) {
        catQRemoved = await supabase
          .from("products")
          .select(catSelectLite)
          .eq("status", "removed")
          .order("updated_at", { ascending: false })
          .limit(80);
      }
      if (catQActive.error) {
        catQActive = await supabase
          .from("products")
          .select(catSelectLegacy)
          .neq("status", "removed")
          .order("updated_at", { ascending: false })
          .limit(120);
      }
      if (catQRemoved.error) {
        catQRemoved = await supabase
          .from("products")
          .select(catSelectLegacy)
          .eq("status", "removed")
          .order("updated_at", { ascending: false })
          .limit(80);
      }
      const activeRows = catQActive.error ? [] : catQActive.data || [];
      const removedRows = catQRemoved.error ? [] : catQRemoved.data || [];
      catalogRows = activeRows.concat(removedRows);
      storeMetrics = computeStoreMetrics(storeRows || []);
      trends7d = await getLastNDaysTrends(supabase, 7);
      learningMetrics = await getLearningMetricsSummary(supabase);
      for (const p of storeRows || []) {
        const t = trackVariantPerformance(p);
        const key = t.variant === "A" ? "A" : t.variant === "B" ? "B" : "none";
        variantMetrics[key].count += 1;
        variantMetrics[key].orders += Number(t.orders) || 0;
        variantMetrics[key].revenue += Number(t.revenue) || 0;
      }
      for (const r of metricRows || []) {
        catalogMetrics.totalViews += Number(r.views) || 0;
        catalogMetrics.totalClicks += Number(r.clicks) || 0;
        catalogMetrics.totalOrders += Number(r.orders_count) || 0;
      }
    }

    const logFeed = recentLogs.map((row) => ({
      created_at: row.created_at,
      action: row.action,
      message: formatAiLogLine(row),
      details: row.details,
    }));

    res.json({
      ok: true,
      adminSecretRequired: adminSecretRequired(),
      ai: automationPayload(),
      products: {
        active: productCount,
        shopVisible: productCount,
        drafts: draftSkus,
        removed: removedCount,
      },
      productCatalog: (catalogRows || []).map((r) => augmentEnrichedProduct(r, enrichProduct(r))),
      catalogMetrics,
      businessMetrics: storeMetrics,
      learningMetrics,
      variantMetrics,
      trends7d,
      productCount,
      recentLogs,
      logFeed,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

/** Ukendte /api/*-stier → JSON 404 (ikke HTML fra static), så admin kan vise en klar fejl. */
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      ok: false,
      message: `API-endepunkt findes ikke: ${req.method} ${req.path}. Genstart serveren fra projektroden (npm run dev), hvis du forventer denne rute.`,
    });
  }
  next();
});

app.use(express.static(path.join(__dirname, "..", "public")));
app.use(errorHandler);

function startServer() {
  const server = app.listen(PORT, () => {
    startAlertEngine();
    logger.info("RUN MODE: server");
    logger.info("WORKERS: enabled");
    startShopEventConsumers(() => supabase);
    logger.info("server.start", { publicUrl: PUBLIC_URL, port: PORT });
    logger.info(
      `[Velden] Sourcing assistant: POST ${PUBLIC_URL}/api/admin/sourcing-chat (verify GET in browser if chat returns 404)`
    );
    logger.info(`[Velden] Server file: ${__filename}`);
    logger.info(
      `[Velden] Sourcing pass every ${Math.round(SOURCING_INTERVAL_MS / 1000)}s — SOURCING_INTERVAL_MS, SOURCING_BATCH_SIZE, SOURCING_DISABLED=1 to stop`
    );

    startAutomationWorker(() => {
      supabase = getSupabase();
      return supabase;
    });
    cleanupOldSourcingChatSessions().catch((e) =>
      logger.warn("sourcing_chat.cleanup.start_failed", { error: e.message || String(e) })
    );
    setInterval(() => {
      cleanupOldSourcingChatSessions().catch((e) =>
        logger.warn("sourcing_chat.cleanup.interval_failed", { error: e.message || String(e) })
      );
    }, 60 * 60 * 1000);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      logger.error(
        `[Velden] Port ${PORT} is already in use. Stop the other process or run: PORT=3001 npm start`
      );
    } else {
      logger.error("server.error", { err });
    }
    process.exit(1);
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, initializeVeldenServerless };
