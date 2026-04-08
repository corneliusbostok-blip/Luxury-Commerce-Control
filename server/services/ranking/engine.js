function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp01(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function computeRates(metrics) {
  const views = safeNum(metrics.views);
  const clicks = safeNum(metrics.clicks);
  const orders = safeNum(metrics.orders);
  const ctr = (clicks + 1) / (views + 10);
  const cvr = (orders + 1) / (clicks + 5);
  const engagement = Math.log1p(Math.max(0, views));
  return { views, clicks, orders, ctr, cvr, engagement };
}

function computeProductRankScore(input) {
  const metrics = input || {};
  const rates = computeRates(metrics);
  const addToCart = safeNum(metrics.add_to_cart || metrics.addToCart);
  const addToCartRate = (addToCart + 1) / (rates.views + 10);
  const revenue = safeNum(metrics.revenue);
  const unitProfit = safeNum(metrics.unit_profit);
  const profit = safeNum(metrics.profit);
  const engagementNorm = clamp01(rates.engagement / 8);
  const ctrNorm = clamp01(rates.ctr / 0.2);
  const cvrNorm = clamp01(rates.cvr / 0.15);
  const atcNorm = clamp01(addToCartRate / 0.08);
  const revenueNorm = clamp01(revenue / 2000);
  const profitNorm = clamp01(Math.max(0, profit) / 700);
  const unitProfitNorm = clamp01(Math.max(0, unitProfit) / 120);
  const freshnessBoost = clamp01(safeNum(metrics.freshnessBoost || 0));
  const penalty = clamp01(safeNum(metrics.penalty || 0));

  const score =
    0.06 * engagementNorm +
    0.08 * ctrNorm +
    0.28 * atcNorm +
    0.3 * cvrNorm +
    0.18 * revenueNorm +
    0.1 * (profitNorm * 0.6 + unitProfitNorm * 0.4) +
    0.05 * freshnessBoost -
    0.1 * penalty;

  return {
    score: Number((Math.max(0, score) * 100).toFixed(2)),
    rates,
  };
}

function resolveRankAction(input) {
  const minViews = Math.max(20, safeNum(input.minViews || 30));
  const daysBelowRemove = Math.max(5, safeNum(input.daysBelowRemove || 10));
  const score = safeNum(input.score);
  const views = safeNum(input.views);
  const daysLow = safeNum(input.daysLow);

  if (score >= 78 && views >= minViews) return "boost";
  if (score < 30 && daysLow >= daysBelowRemove) return "remove";
  if (score < 45 && views >= minViews) return "deprioritize";
  return "keep";
}

module.exports = {
  computeProductRankScore,
  resolveRankAction,
};
