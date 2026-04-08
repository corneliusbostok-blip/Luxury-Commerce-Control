function adjustPricesForAOV(products, storeMetrics, opts = {}) {
  const list = products || [];
  const metrics = storeMetrics || {};
  const aggressiveness = Number(opts.pricingAggressiveness || 1);
  const elasticityByCategory = opts.elasticityByCategory || {};
  const targetMargin = Number(opts.targetMargin);
  const configuredRange = opts.priceRange || {};
  const targetAov = Number(process.env.TARGET_AOV || 1200);
  const convFloor = Number(process.env.CONVERSION_FLOOR || 0.015);
  const updates = [];

  for (const p of list) {
    if (!p || p.status === "removed") continue;
    const price = Number(p.price) || 0;
    if (price <= 0) continue;
    let next = price;
    if (metrics.AOV < targetAov && price >= 600 && price <= 2000) {
      next = price * (1 + 0.03 * aggressiveness);
    } else if ((metrics.avgConversionRate || 0) < convFloor && price < 700) {
      next = price * (1 - 0.03 * aggressiveness);
    }
    const catMult = Number(elasticityByCategory[String(p.category || "other")]) || 1;
    next = next * catMult;
    if (Number.isFinite(targetMargin) && targetMargin > 0 && targetMargin < 0.95) {
      const floor = (Number(p.cost) || 0) / Math.max(0.05, 1 - targetMargin);
      if (Number.isFinite(floor) && floor > 0) next = Math.max(next, floor);
    }
    const rangeMin = Number(configuredRange.min);
    const rangeMax = Number(configuredRange.max);
    if (Number.isFinite(rangeMin)) next = Math.max(next, rangeMin);
    if (Number.isFinite(rangeMax) && rangeMax > 0) next = Math.min(next, rangeMax);
    if (Math.abs(next - price) / Math.max(price, 1) < 0.01) continue;
    updates.push({ id: p.id, newPrice: Math.round(next * 100) / 100, reason: "global_pricing_strategy" });
  }
  return updates;
}

module.exports = {
  adjustPricesForAOV,
};
