/**
 * AI CEO / decision engine (Velden automation)
 *
 * Inputs: full product rows (views, clicks, orders_count, price, cost, …) + AiMemory insights.
 * Score: (orders * 5) + clicks - (views * 0.1) — synced to DB each cycle.
 * Output: structured plan (remove / scale / add count / price updates / content targets / insights).
 * Gemini when any GEMINI_API_KEY* is set; else heuristicPlan().
 */
const { stripJsonFence } = require("../lib/ai-json");
const { geminiGenerateText, collectGeminiApiKeys } = require("../lib/gemini");

/**
 * Profit-aware performance index normalized to 0-100.
 */
function performanceScore(p) {
  const orders = Number(p.orders_count) || 0;
  const clicks = Number(p.clicks) || 0;
  const views = Number(p.views) || 0;
  const price = Number(p.price) || 0;
  const cost = Number(p.cost) || 0;
  const shipping = Number(p.estimated_shipping_cost) || 0;
  const returnRisk = Number(p.return_risk_proxy) || 0;
  const unitMargin = Math.max(0, price - cost - shipping - returnRisk);
  const profit = orders * unitMargin;
  const conversion = orders / Math.max(views, 1);
  const velocity = views > 0 ? (clicks + orders) / views : 0;
  const marginQuality = price > 0 ? unitMargin / price : 0;
  const profitDensity = unitMargin * conversion;
  const raw =
    profit * 0.48 +
    conversion * 100 * 0.24 +
    velocity * 100 * 0.1 +
    marginQuality * 12 +
    profitDensity * 20;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Normalizes Gemini (or legacy) JSON into one execution plan + spec-shaped fields for logging/UI.
 */
function parseCeoPlan(json) {
  const src = json && typeof json === "object" ? json : {};
  const removeProductIds = (Array.isArray(src.removeProductIds) ? src.removeProductIds : src.removeIds || [])
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  const scaleProductIds = (Array.isArray(src.scaleProductIds) ? src.scaleProductIds : src.scaleIds || [])
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  let rawPrice = json.priceUpdates || json.priceAdjustments || [];
  if (!Array.isArray(rawPrice)) rawPrice = [];
  const priceUpdates = rawPrice
    .map((p) => ({
      id: p.id || p.productId,
      newPrice: p.newPrice != null ? p.newPrice : p.price,
    }))
    .map((p) => ({
      id: String(p.id || "").trim(),
      newPrice: Number(p.newPrice),
    }))
    .filter((p) => p.id && Number.isFinite(p.newPrice) && p.newPrice > 0);
  const addProducts = Math.min(4, Math.max(0, Number(src.addProducts ?? src.addCount) || 0));
  const contentTargets = [
    ...new Set(
      [
        ...(Array.isArray(src.contentTargets) ? src.contentTargets : []),
        ...(Array.isArray(src.contentProductIds) ? src.contentProductIds : []),
        ...(Array.isArray(src.promoteProductIds) ? src.promoteProductIds : []),
      ]
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    ),
  ];
  const insights = (Array.isArray(src.insights) ? src.insights : []).map((x) => String(x || "").trim()).filter(Boolean);

  return {
    removeProductIds,
    scaleProductIds,
    priceUpdates,
    addProducts,
    contentTargets,
    insights,
    removeIds: removeProductIds,
    scaleIds: scaleProductIds,
    priceAdjustments: priceUpdates,
    addCount: addProducts,
    contentProductIds: contentTargets,
    promoteProductIds: [],
  };
}

function heuristicPlan(products, constraints = {}) {
  const risk = String((constraints && constraints.risk) || "balanced").toLowerCase();
  const scoreCut = risk === "low" ? 4 : risk === "high" ? 12 : 8;
  const viewCut = risk === "low" ? 120 : risk === "high" ? 60 : 80;
  const priceMult = risk === "low" ? 1.02 : risk === "high" ? 1.05 : 1.03;
  const addCap = risk === "low" ? 1 : risk === "high" ? 3 : 2;

  const enriched = products.map((p) => ({
    ...p,
    computedScore: performanceScore(p),
  }));
  const sorted = [...enriched].sort((a, b) => b.computedScore - a.computedScore);
  const removeProductIds = enriched
    .filter((p) => p.computedScore < scoreCut && p.views > viewCut)
    .map((p) => p.id);
  const scaleProductIds = sorted.slice(0, 2).map((p) => p.id);
  const winners = sorted.slice(0, 2).filter((p) => p.computedScore > 2);
  const priceUpdates = winners.map((p) => {
    const bump = Math.round(Number(p.price) * priceMult * 100) / 100;
    return { id: p.id, newPrice: Math.max(29, bump) };
  });
  const contentTargets = enriched
    .filter((p) => !p.tiktok_script || String(p.tiktok_script).length < 20)
    .slice(0, 3)
    .map((p) => p.id);

  return parseCeoPlan({
    removeProductIds,
    scaleProductIds,
    priceUpdates,
    addProducts:
      enriched.filter(
        (p) =>
          p.status !== "removed" &&
          (p.sourcing_status === "approved" ||
            p.sourcing_status == null ||
            p.sourcing_status === "")
      ).length < 4
        ? addCap
        : 0,
    contentTargets,
    insights: [
      "Heuristic cycle: pruning weak SKUs; scaling top performers across Velden collections.",
      `Top movers: ${sorted.slice(0, 3).map((p) => p.name).join(", ") || "n/a"}.`,
    ],
  });
}

/**
 * Gemini CEO brain — returns parseCeoPlan shape. Falls back to heuristicPlan on missing key or errors.
 */
async function decideWithGemini({
  products,
  memories,
  businessMetrics,
  trendData,
  objective,
  constraints,
  experimentResults,
  recentDecisions,
  attributionResults,
  categoryLearning,
  storeConfig,
}) {
  if (!collectGeminiApiKeys().length) return heuristicPlan(products, constraints);

  const memoryText = (memories || [])
    .map((m) => `- ${m.insight}`)
    .join("\n");

  const payload = products.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category || "other",
    sourcing_status: p.sourcing_status || "approved",
    cost: p.cost,
    estimated_shipping_cost: p.estimated_shipping_cost || 0,
    unit_profit:
      Number(p.unit_profit) ||
      Math.max(0, (Number(p.price) || 0) - (Number(p.cost) || 0) - (Number(p.estimated_shipping_cost) || 0)),
    price: p.price,
    score: p.score,
    status: p.status,
    views: p.views,
    clicks: p.clicks,
    orders: p.orders_count,
    performanceScore: performanceScore(p),
  }));

  const prompt = `You are the CEO decision engine for "Velden", a quiet-luxury men's fashion house (old-money, quiet luxury: men's shirts, knitwear, trousers, outerwear, shoes, watches, accessories only—never women's or kids, no streetwear).

Past AI memory (stay consistent with prior calls):
${memoryText || "(none yet)"}

Products (JSON):
${JSON.stringify(payload, null, 2)}

Business metrics:
${JSON.stringify(businessMetrics || {}, null, 2)}

Trend data (latest first):
${JSON.stringify(trendData || [], null, 2)}

Objective:
${JSON.stringify(objective || "maximize_profit")}

Constraints:
${JSON.stringify(constraints || {}, null, 2)}

Experiment results:
${JSON.stringify(experimentResults || {}, null, 2)}

Recent decisions:
${JSON.stringify(recentDecisions || [], null, 2)}

Outcome attribution:
${JSON.stringify(attributionResults || {}, null, 2)}

Category learning memory:
${JSON.stringify(categoryLearning || {}, null, 2)}

Store config (brand-aware policy):
${JSON.stringify(storeConfig || {}, null, 2)}

Catalog size policy: when maxCatalogProducts is greater than 0 and catalogProductCount is greater than or equal to maxCatalogProducts, set addProducts to 0 (catalog is at the owner's cap). After removals in removeProductIds are applied, a future cycle may add again. When maxCatalogProducts is 0, there is no cap.

Risk policy: constraints.risk is typically "low", "balanced", or "high" from store settings. Apply it when choosing removals, addProducts, and priceUpdates — low = fewer removals and smaller experiments; high = allow more aggressive catalog rotation and pricing moves while still respecting minMargin and maxCategoryShare.

Each product has a "category" slug (polos, shirts, knitwear, trousers, outerwear, shoes, watches, accessories, other) and "sourcing_status" (draft = not yet cleared for storefront, approved = live-eligible, treat rejected as already excluded). Prefer removing chronic underperformers and off-brief SKUs; drafts with poor fit may be removed.

Performance index is profit-first and normalized 0-100 (profit + conversion + velocity + profit density per catalog slot). The "score" field is the stored DB value (synced from this formula).
Prioritize high profit density per slot over raw engagement.

Your JSON response MUST use exactly these keys:
- removeProductIds: string[] — UUIDs to mark removed (chronic underperformers, off-brief SKUs, poor catalog fit for men's fashion).
- scaleProductIds: string[] — UUIDs to mark "scaling" (winners to push).
- priceUpdates: { "id": string, "newPrice": number }[] — small tweaks; prefer charm endings 7, 9, 5; you may raise prices modestly on clear winners.
- addProducts: number — how many NEW listings to source this cycle (0-4).
- contentTargets: string[] — UUIDs that need refreshed marketing copy / TikTok script / captions.
- insights: string[] — 2-4 short strings persisted as memory for the next cycle.

Return ONLY valid JSON, no markdown:
{
  "removeProductIds": [],
  "scaleProductIds": [],
  "priceUpdates": [],
  "addProducts": 0,
  "contentTargets": [],
  "insights": []
}`;

  try {
    const text = await geminiGenerateText(prompt);
    const json = JSON.parse(stripJsonFence(text));
    return parseCeoPlan(json);
  } catch (e) {
    console.warn("[brain] Gemini failed, using heuristics:", e.message);
    return heuristicPlan(products, constraints);
  }
}

module.exports = {
  decideWithGemini,
  performanceScore,
  heuristicPlan,
  parseCeoPlan,
};
