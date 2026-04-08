function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function attributeCycleOutcome(beforeMetrics, afterMetrics, decisions) {
  const before = beforeMetrics || {};
  const after = afterMetrics || {};
  const list = decisions || [];

  const profitDelta = toNum(after.totalProfit) - toNum(before.totalProfit);
  const conversionDelta = toNum(after.avgConversionRate) - toNum(before.avgConversionRate);
  const marginDelta = toNum(after.avgMargin) - toNum(before.avgMargin);

  const out = list.map((d) => {
    const type = String(d.type || d.decision_type || "unknown");
    let contribution = 0;
    if (type === "price") contribution = profitDelta * 0.45 + marginDelta * 120;
    else if (type === "scale") contribution = profitDelta * 0.25 + conversionDelta * 90;
    else if (type === "remove") contribution = profitDelta * 0.15 + marginDelta * 70;
    else if (type.includes("source")) contribution = profitDelta * 0.2;
    else if (type.includes("experiment")) contribution = conversionDelta * 110 + profitDelta * 0.2;
    return {
      decision_type: type,
      product_id: d.id || d.product_id || null,
      estimated_contribution: Math.round(contribution * 100) / 100,
      signal: contribution >= 0 ? "helped" : "hurt",
    };
  });

  return {
    profitDelta: Math.round(profitDelta * 100) / 100,
    conversionDelta: Math.round(conversionDelta * 10000) / 10000,
    marginDelta: Math.round(marginDelta * 10000) / 10000,
    attributions: out,
  };
}

function computeDecisionQualityScore(ctx) {
  const c = ctx || {};
  const profit = toNum(c.profitDelta);
  const margin = toNum(c.marginDelta) * 100;
  const conv = toNum(c.conversionDelta) * 100;
  const stabilityPenalty = toNum(c.stabilityPenalty);
  const rollbackPenalty = c.rollbackTriggered ? 35 : 0;
  const score = profit * 0.45 + margin * 0.25 + conv * 0.2 - stabilityPenalty - rollbackPenalty;
  return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = {
  attributeCycleOutcome,
  computeDecisionQualityScore,
};
