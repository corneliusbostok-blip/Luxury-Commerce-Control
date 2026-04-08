async function rebuildCategoryLearning(supabase, products) {
  if (!supabase) return [];
  const grouped = new Map();
  for (const p of products || []) {
    if (p.status === "removed") continue;
    const c = String(p.category || "other");
    const cur = grouped.get(c) || {
      category: c,
      n: 0,
      profit: 0,
      conv: 0,
      priceSensitivity: 0,
      sourceHits: {},
      expWins: 0,
      expTotal: 0,
    };
    const orders = Number(p.orders_count) || 0;
    const price = Number(p.price) || 0;
    const cost = Number(p.cost) || 0;
    const views = Number(p.views) || 0;
    cur.n += 1;
    cur.profit += orders * Math.max(0, price - cost);
    cur.conv += orders / Math.max(views, 1);
    const src = String(p.source_name || p.source_platform || "unknown");
    cur.sourceHits[src] = (cur.sourceHits[src] || 0) + 1;
    grouped.set(c, cur);
  }
  const rows = [...grouped.values()].map((g) => {
    const topSourceCount = Math.max(...Object.values(g.sourceHits || { _: 1 }));
    return {
      category: g.category,
      avg_profit: g.n > 0 ? Math.round((g.profit / g.n) * 100) / 100 : 0,
      avg_conversion: g.n > 0 ? Math.round((g.conv / g.n) * 10000) / 10000 : 0,
      price_sensitivity: 0,
      experiment_win_rate: g.expTotal > 0 ? g.expWins / g.expTotal : null,
      source_success_concentration: g.n > 0 ? Math.round((topSourceCount / g.n) * 10000) / 10000 : 0,
      updated_at: new Date().toISOString(),
    };
  });
  if (!rows.length) return [];
  await supabase.from("category_learning").upsert(rows, { onConflict: "category" });
  return rows;
}

async function loadCategoryLearningMap(supabase) {
  if (!supabase) return new Map();
  const { data, error } = await supabase.from("category_learning").select("*");
  if (error || !data) return new Map();
  return new Map(data.map((r) => [String(r.category || "other"), r]));
}

module.exports = {
  rebuildCategoryLearning,
  loadCategoryLearningMap,
};
