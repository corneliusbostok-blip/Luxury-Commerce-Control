function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function tokenizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3)
    .slice(0, 12);
}

function priceBucket(price) {
  const p = n(price);
  if (p < 50) return "low";
  if (p < 200) return "mid";
  if (p < 600) return "high";
  return "premium";
}

function collectProductFeedback(products = []) {
  const winners = [];
  const losers = [];
  for (const p of products || []) {
    const views = n(p.views);
    const clicks = n(p.clicks);
    const orders = n(p.orders_count);
    const price = n(p.price);
    const ctr = views > 0 ? clicks / views : 0;
    const cvr = clicks > 0 ? orders / clicks : 0;
    const revenue = orders * price;
    const row = { id: p.id, title: p.name || "", category: p.category || "other", price, ctr, cvr, revenue, orders, views, clicks, sourceName: p.source_name || "" };
    if (orders > 5 || cvr > 0.03) winners.push(row);
    if (views > 50 && orders === 0) losers.push(row);
  }
  return { winners, losers };
}

function topNCounts(items, limit = 12) {
  const m = new Map();
  for (const x of items || []) m.set(x, (m.get(x) || 0) + 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

function extractLearningFeatures(feedback = {}) {
  const winners = feedback.winners || [];
  const losers = feedback.losers || [];
  const winKeywords = topNCounts(winners.flatMap((p) => tokenizeTitle(p.title)), 14);
  const loseKeywords = topNCounts(losers.flatMap((p) => tokenizeTitle(p.title)), 14);
  const topCategories = topNCounts(winners.map((p) => p.category || "other"), 8);
  const losingCategories = topNCounts(losers.map((p) => p.category || "other"), 8);
  const priceRanges = {
    winners: topNCounts(winners.map((p) => priceBucket(p.price)), 4),
    losers: topNCounts(losers.map((p) => priceBucket(p.price)), 4),
  };
  return {
    topCategories,
    winningKeywords: winKeywords,
    losingKeywords: loseKeywords,
    priceRanges,
    losingCategories,
  };
}

module.exports = {
  collectProductFeedback,
  extractLearningFeatures,
};
