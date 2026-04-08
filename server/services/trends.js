const { computeStoreMetrics } = require("./business-metrics");

function todayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

async function recordDailyMetrics(supabase, products) {
  if (!supabase) return null;
  const store = computeStoreMetrics(products || []);
  const avgScore =
    (products || []).length > 0
      ? (products || []).reduce((a, p) => a + (Number(p.score) || 0), 0) / (products || []).length
      : 0;
  const row = {
    date: todayDateKey(),
    revenue: store.totalRevenue,
    profit: store.totalProfit,
    avg_score: Math.round(avgScore * 100) / 100,
    product_count: (products || []).length,
  };
  await supabase.from("daily_metrics").upsert(row, { onConflict: "date" });
  return row;
}

async function getLastNDaysTrends(supabase, n = 7) {
  if (!supabase) return [];
  const lim = Math.max(1, Math.min(60, Number(n) || 7));
  const { data, error } = await supabase
    .from("daily_metrics")
    .select("date, revenue, profit, avg_score, product_count")
    .order("date", { ascending: false })
    .limit(lim);
  if (error) return [];
  return data || [];
}

module.exports = {
  recordDailyMetrics,
  getLastNDaysTrends,
};
