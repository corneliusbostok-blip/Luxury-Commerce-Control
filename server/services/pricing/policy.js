function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function charm99(price) {
  if (!Number.isFinite(price) || price <= 0) return 0;
  const whole = Math.max(1, Math.floor(price));
  return Number((whole + 0.99).toFixed(2));
}

function computePricingPolicy(input = {}, context = {}) {
  const supplier = n(input.supplier_price ?? input.cost ?? input.price, 0);
  const market = n(input.market_price ?? input.source_price ?? input.price, 0);
  const popularity = n(input.popularity_score, NaN);
  const confidence = String(input.confidence || "medium").toLowerCase();
  const ctr = n(context.ctr ?? input.ctr, 0);
  const cvr = n(context.cvr ?? input.cvr, 0);
  const goalRaw = String(context.goal || input.goal || "profit").toLowerCase();
  const goal = goalRaw.includes("growth") ? "growth" : "profit";
  const shipping = n(input.estimated_shipping_cost ?? context.estimated_shipping_cost, 0);
  const minMarginFloor = clamp(n(context.minMarginFloor ?? process.env.MIN_MARGIN_THRESHOLD, 0.25), 0.05, 0.9);

  const baseCost = supplier > 0 ? supplier : market;
  let multiplier = goal === "growth" ? 1.7 : 2.7;
  if (goal === "growth" && cvr > 0.03) multiplier -= 0.08;
  if (goal === "profit" && cvr > 0.03) multiplier += 0.1;
  if (Number.isFinite(popularity)) {
    if (popularity >= 70) multiplier += 0.2;
    else if (popularity <= 35) multiplier -= 0.1;
  }
  if (confidence === "high") multiplier += 0.12;
  else if (confidence === "low") multiplier -= 0.1;
  if (ctr > 0.06 && goal === "growth") multiplier -= 0.05;

  multiplier = clamp(multiplier, 1.2, 4);

  let suggested = baseCost > 0 ? baseCost * multiplier : market > 0 ? market : 99;
  if (market > 0) {
    const upper = market * 1.35;
    const lower = market * 0.75;
    suggested = clamp(suggested, lower, upper);
  }
  if (baseCost > 0) {
    const floorFromMargin = baseCost / Math.max(0.01, 1 - minMarginFloor);
    const floorFromShipping = baseCost + shipping + Math.max(5, baseCost * 0.08);
    suggested = Math.max(suggested, floorFromMargin, floorFromShipping);
  }
  suggested = charm99(suggested);
  const unitProfit = Number((suggested - baseCost - shipping).toFixed(2));
  const margin = baseCost > 0 ? Number((((suggested - baseCost) / baseCost) * 100).toFixed(2)) : null;
  return { suggested_price: suggested, margin, unit_profit: unitProfit, multiplier, goal, popularity, confidence };
}

module.exports = { computePricingPolicy };
