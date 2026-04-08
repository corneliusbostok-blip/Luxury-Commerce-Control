async function updateSourceMetrics(supabase, products) {
  if (!supabase) return;
  const grouped = new Map();
  for (const p of products || []) {
    const source = String(p.source_name || p.source_platform || "unknown").trim() || "unknown";
    const profit = (Number(p.orders_count) || 0) * Math.max(0, (Number(p.price) || 0) - (Number(p.cost) || 0));
    const ok = (Number(p.orders_count) || 0) > 0 ? 1 : 0;
    const cur = grouped.get(source) || { source_name: source, profit: 0, n: 0, success: 0 };
    cur.profit += profit;
    cur.n += 1;
    cur.success += ok;
    grouped.set(source, cur);
  }
  const rows = [...grouped.values()].map((g) => ({
    source_name: g.source_name,
    avg_profit: g.n > 0 ? Math.round((g.profit / g.n) * 100) / 100 : 0,
    success_rate: g.n > 0 ? Math.round((g.success / g.n) * 10000) / 10000 : 0,
    updated_at: new Date().toISOString(),
  }));
  if (!rows.length) return;
  await supabase.from("source_metrics").upsert(rows, { onConflict: "source_name" });
}

async function loadSourceMetricsMap(supabase) {
  if (!supabase) return new Map();
  const { data, error } = await supabase.from("source_metrics").select("source_name, avg_profit, success_rate");
  if (error || !data) return new Map();
  return new Map(data.map((r) => [String(r.source_name || "").toLowerCase(), r]));
}

function sourceDiscoveryWeight(sourceMetric) {
  const s = sourceMetric || {};
  const success = Number(s.success_rate) || 0;
  const avgProfit = Number(s.avg_profit) || 0;
  if (success < 0.12) return 0.18;
  if (success < 0.22) return 0.42;
  if (success > 0.55 && avgProfit > 0) return 1.45;
  if (success > 0.4) return 1.2;
  return 1;
}

module.exports = {
  updateSourceMetrics,
  loadSourceMetricsMap,
  sourceDiscoveryWeight,
};
