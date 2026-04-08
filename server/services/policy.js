const MIN_SCALE_SCORE = Number(process.env.AUTOMATION_MIN_SCALE_SCORE || 55);
const MAX_CATEGORY_SHARE = Number(process.env.MAX_CATEGORY_SHARE || 0.4);

function clampPriceChange(oldPrice, nextPrice) {
  const oldP = Number(oldPrice) || 0;
  const n = Number(nextPrice) || oldP;
  if (oldP <= 0) return n;
  const min = oldP * 0.7;
  const max = oldP * 1.3;
  return Math.max(min, Math.min(max, n));
}

function topScoringIds(products, topShare) {
  const active = (products || []).filter((p) => p.status !== "removed");
  const sorted = [...active].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  const keep = Math.max(1, Math.ceil(sorted.length * topShare));
  return new Set(sorted.slice(0, keep).map((p) => p.id));
}

function enforceBusinessRules(plan, products) {
  const srcPlan = plan || {};
  const list = products || [];
  const byId = Object.fromEntries(list.map((p) => [p.id, p]));
  const active = list.filter((p) => p.status !== "removed");
  const maxRemovals = Math.max(1, Math.floor(active.length * 0.2));
  const top10 = topScoringIds(active, 0.1);

  const removeIds = [];
  for (const id of srcPlan.removeIds || srcPlan.removeProductIds || []) {
    const p = byId[id];
    if (!p || p.status === "removed") continue;
    if (top10.has(id)) continue;
    if (removeIds.length >= maxRemovals) break;
    removeIds.push(id);
  }

  const scaleIds = [];
  for (const id of srcPlan.scaleIds || srcPlan.scaleProductIds || []) {
    const p = byId[id];
    if (!p || p.status === "removed") continue;
    const confidence =
      Number(p.confidence_score) ||
      (Number(p.ai_fit_score) || 0) * 0.5 + (Number(p.performance_score) || Number(p.score) || 0) * 0.5;
    if ((Number(p.score) || 0) < MIN_SCALE_SCORE || confidence < MIN_SCALE_SCORE) continue;
    scaleIds.push(id);
  }

  const priceAdjustments = [];
  for (const adj of srcPlan.priceAdjustments || srcPlan.priceUpdates || []) {
    const p = byId[adj.id];
    if (!p) continue;
    const oldPrice = Number(p.price) || 0;
    const clamped = clampPriceChange(oldPrice, adj.newPrice);
    const minMarginPrice = Math.max(29, (Number(p.cost) || 0) * 2.2);
    const safe = Math.max(minMarginPrice, clamped);
    priceAdjustments.push({ id: adj.id, newPrice: Math.round(safe * 100) / 100 });
  }

  return {
    ...srcPlan,
    removeIds,
    removeProductIds: removeIds,
    scaleIds,
    scaleProductIds: scaleIds,
    priceAdjustments,
    priceUpdates: priceAdjustments,
  };
}

function categoryDistribution(products) {
  const active = (products || []).filter((p) => p.status !== "removed");
  const total = Math.max(1, active.length);
  const counts = {};
  for (const p of active) {
    const c = String(p.category || "other");
    counts[c] = (counts[c] || 0) + 1;
  }
  const out = {};
  Object.keys(counts).forEach((k) => {
    out[k] = counts[k] / total;
  });
  return out;
}

function canInsertCategory(category, products) {
  const c = String(category || "other");
  const dist = categoryDistribution(products);
  return (dist[c] || 0) < MAX_CATEGORY_SHARE;
}

function categoryRankPenalty(category, products) {
  const c = String(category || "other");
  const dist = categoryDistribution(products);
  const share = dist[c] || 0;
  if (share <= MAX_CATEGORY_SHARE) return 0;
  return Math.min(25, Math.round((share - MAX_CATEGORY_SHARE) * 100));
}

function normalizeRiskLevel(risk) {
  const x = String(risk || "balanced").toLowerCase();
  if (x.includes("low")) return "low";
  if (x.includes("high")) return "high";
  return "balanced";
}

/**
 * Hard caps after AI plan + enforceBusinessRules — AI cannot exceed store risk policy.
 * @param {{ adaptMultiplier?: number }} [opts] — from risk-adaptation (stable → >1, unstable → <1).
 */
function enforceRiskCapsOnPlan(plan, products, riskRaw, opts = {}) {
  const risk = normalizeRiskLevel(riskRaw);
  const f = Math.max(0.65, Math.min(1.35, Number(opts.adaptMultiplier) || 1));
  const src = plan || {};
  const list = products || [];
  const active = list.filter((p) => p && p.status !== "removed");
  const n = Math.max(1, active.length);
  const byId = Object.fromEntries(list.map((p) => [p.id, p]));

  const maxRemoveFrac = risk === "low" ? 0.08 : risk === "high" ? 0.22 : 0.15;
  const maxRemovals = Math.max(1, Math.floor(n * maxRemoveFrac * f));

  const baseAdds = risk === "low" ? 1 : risk === "high" ? 4 : 3;
  const maxAdds = Math.max(risk === "low" ? 0 : 1, Math.floor(baseAdds * f));
  const baseScale = risk === "low" ? 8 : risk === "high" ? 45 : 28;
  const maxScale = Math.max(1, Math.floor(baseScale * f));
  const basePriceRows = risk === "low" ? 6 : risk === "high" ? 30 : 18;
  const maxPriceRows = Math.max(1, Math.floor(basePriceRows * f));
  const baseDelta = risk === "low" ? 0.05 : risk === "high" ? 0.12 : 0.08;
  const maxPriceDeltaFrac = Math.min(0.15, Math.max(0.02, baseDelta * f));

  const rawRemove = [...(src.removeProductIds || src.removeIds || [])].map((id) => String(id || "").trim()).filter(Boolean);
  const removeProductIds = rawRemove.slice(0, maxRemovals);

  const rawScale = [...(src.scaleProductIds || src.scaleIds || [])].map((id) => String(id || "").trim()).filter(Boolean);
  const scaleProductIds = rawScale.slice(0, maxScale);

  let addProducts = Math.min(maxAdds, Math.max(0, Math.floor(Number(src.addProducts ?? src.addCount) || 0)));

  const rawPrices = src.priceUpdates || src.priceAdjustments || [];
  const priceUpdates = [];
  for (const adj of Array.isArray(rawPrices) ? rawPrices : []) {
    if (priceUpdates.length >= maxPriceRows) break;
    const p = byId[adj.id];
    if (!p) continue;
    const oldPrice = Number(p.price) || 0;
    if (oldPrice <= 0) continue;
    const want = Number(adj.newPrice != null ? adj.newPrice : adj.price);
    if (!Number.isFinite(want)) continue;
    const lo = oldPrice * (1 - maxPriceDeltaFrac);
    const hi = oldPrice * (1 + maxPriceDeltaFrac);
    const riskClamped = Math.max(lo, Math.min(hi, want));
    const globallyClamped = clampPriceChange(oldPrice, riskClamped);
    const minMarginPrice = Math.max(29, (Number(p.cost) || 0) * 2.2);
    const safe = Math.max(minMarginPrice, globallyClamped);
    priceUpdates.push({ id: adj.id, newPrice: Math.round(safe * 100) / 100 });
  }

  return {
    ...src,
    removeProductIds,
    removeIds: removeProductIds,
    scaleProductIds,
    scaleIds: scaleProductIds,
    addProducts,
    addCount: addProducts,
    priceUpdates,
    priceAdjustments: priceUpdates,
  };
}

module.exports = {
  enforceBusinessRules,
  enforceRiskCapsOnPlan,
  canInsertCategory,
  categoryRankPenalty,
  categoryDistribution,
};
