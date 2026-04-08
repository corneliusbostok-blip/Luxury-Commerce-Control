function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function daysSince(ts) {
  const t = new Date(ts || 0).getTime();
  if (!Number.isFinite(t) || t <= 0) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function analyzeProductPerformance(products = []) {
  const weakProducts = [];
  const strongProducts = [];

  for (const p of products) {
    if (!p || !p.id) continue;
    const views = num(p.views);
    const clicks = num(p.clicks);
    const orders = num(p.orders_count);
    const ctr = views > 0 ? clicks / views : 0;
    const cvr = clicks > 0 ? orders / clicks : 0;
    const ageDays = daysSince(p.created_at);

    const weak =
      (views > 50 && ctr < 0.01) ||
      (clicks > 20 && orders === 0) ||
      (ageDays != null && ageDays > 14 && orders === 0);
    const strong = orders > 5 || cvr > 0.02;

    const base = { id: p.id, name: p.name || "", ctr, cvr, ageDays, views, clicks, orders, status: p.status || "" };
    if (weak) weakProducts.push(base);
    if (strong) strongProducts.push(base);
  }

  return { weakProducts, strongProducts };
}

module.exports = { analyzeProductPerformance };
