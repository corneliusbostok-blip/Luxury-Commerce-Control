function buildQueryFeedback(events) {
  const grouped = new Map();
  for (const e of events || []) {
    const q = String(e.sourceQuery || "unknown").trim().toLowerCase();
    if (!grouped.has(q)) grouped.set(q, { views: 0, clicks: 0, add_to_cart: 0, orders: 0, revenue: 0 });
    const row = grouped.get(q);
    row.views += Number(e.views) || 0;
    row.clicks += Number(e.clicks) || 0;
    row.add_to_cart += Number(e.add_to_cart) || 0;
    row.orders += Number(e.orders) || 0;
    row.revenue += Number(e.revenue) || 0;
  }

  const rewrites = [];
  for (const [query, m] of grouped.entries()) {
    const ctr = (m.clicks + 1) / (m.views + 10);
    const atcRate = (m.add_to_cart + 1) / (m.views + 10);
    const cvr = (m.orders + 1) / (m.clicks + 5);
    const revenuePerView = (m.revenue + 1) / (m.views + 10);
    if (atcRate < 0.02 || cvr < 0.02 || revenuePerView < 0.8) {
      rewrites.push({
        query,
        action: "rewrite",
        suggestion: `${query} high margin premium quality`,
        score: Number(
          (Math.max(0, 0.03 - ctr) + Math.max(0, 0.02 - atcRate) + Math.max(0, 0.02 - cvr) + Math.max(0, 0.8 - revenuePerView)).toFixed(4)
        ),
      });
    }
  }
  return rewrites;
}

module.exports = { buildQueryFeedback };
