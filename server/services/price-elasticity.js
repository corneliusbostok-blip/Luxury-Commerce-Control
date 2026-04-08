async function recordPriceElasticityChange(supabase, product, oldPrice, newPrice, cycleId) {
  if (!supabase || !product || !product.id) return;
  const beforeConversion = (Number(product.orders_count) || 0) / Math.max(Number(product.views) || 0, 1);
  await supabase.from("price_elasticity").insert({
    product_id: product.id,
    category: product.category || null,
    old_price: Number(oldPrice) || 0,
    new_price: Number(newPrice) || 0,
    before_conversion: beforeConversion,
    after_conversion: null,
    cycle_id: cycleId || null,
    observed_at: new Date().toISOString(),
  });
}

async function backfillElasticityOutcomes(supabase, productsById) {
  if (!supabase) return;
  const { data, error } = await supabase
    .from("price_elasticity")
    .select("id, product_id")
    .is("after_conversion", null)
    .order("observed_at", { ascending: false })
    .limit(200);
  if (error || !data) return;
  for (const row of data) {
    const p = productsById[row.product_id];
    if (!p) continue;
    const conv = (Number(p.orders_count) || 0) / Math.max(Number(p.views) || 0, 1);
    await supabase.from("price_elasticity").update({ after_conversion: conv }).eq("id", row.id);
  }
}

async function elasticityMultiplierForCategory(supabase, category) {
  if (!supabase) return 1;
  const cat = String(category || "");
  const { data, error } = await supabase
    .from("price_elasticity")
    .select("before_conversion, after_conversion")
    .eq("category", cat)
    .not("after_conversion", "is", null)
    .order("observed_at", { ascending: false })
    .limit(40);
  if (error || !data || !data.length) return 1;
  let gain = 0;
  for (const r of data) gain += (Number(r.after_conversion) || 0) - (Number(r.before_conversion) || 0);
  const avg = gain / data.length;
  if (avg > 0.004) return 1.03;
  if (avg < -0.004) return 0.97;
  return 1;
}

module.exports = {
  recordPriceElasticityChange,
  backfillElasticityOutcomes,
  elasticityMultiplierForCategory,
};
