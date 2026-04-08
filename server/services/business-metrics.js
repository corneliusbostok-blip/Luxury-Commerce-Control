function computeProductMetrics(product) {
  const p = product || {};
  const orders = Number(p.orders_count) || 0;
  const price = Number(p.price) || 0;
  const cost = Number(p.cost) || 0;
  const shipping = Number(p.estimated_shipping_cost) || 0;
  const returnRisk = Number(p.return_risk_proxy) || 0;
  const views = Number(p.views) || 0;
  const revenue = orders * price;
  const unitProfit = Math.max(0, (Number(p.unit_profit) || 0) || price - cost - shipping - returnRisk);
  const profit = orders * unitProfit;
  const margin = price > 0 ? (price - cost) / price : 0;
  const conversion_rate = orders / Math.max(views, 1);
  return { revenue, profit, margin, conversion_rate, unitProfit };
}

function computeStoreMetrics(products) {
  const list = products || [];
  if (!list.length) {
    return {
      totalRevenue: 0,
      totalProfit: 0,
      avgMargin: 0,
      avgConversionRate: 0,
      AOV: 0,
    };
  }
  let totalRevenue = 0;
  let totalProfit = 0;
  let marginSum = 0;
  let convSum = 0;
  let orderCount = 0;
  for (const p of list) {
    const m = computeProductMetrics(p);
    totalRevenue += m.revenue;
    totalProfit += m.profit;
    marginSum += m.margin;
    convSum += m.conversion_rate;
    orderCount += Number(p.orders_count) || 0;
  }
  return {
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalProfit: Math.round(totalProfit * 100) / 100,
    avgMargin: Math.round((marginSum / list.length) * 10000) / 10000,
    avgConversionRate: Math.round((convSum / list.length) * 10000) / 10000,
    AOV: orderCount > 0 ? Math.round((totalRevenue / orderCount) * 100) / 100 : 0,
  };
}

module.exports = {
  computeProductMetrics,
  computeStoreMetrics,
};
