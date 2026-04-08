const { computePricingPolicy } = require("./policy");

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function computeOptimalPrice(product = {}, context = {}) {
  const out = computePricingPolicy(product, context);
  return {
    suggested_price: out.suggested_price,
    margin: out.margin,
    unit_profit: out.unit_profit,
    reasoning: `goal=${out.goal}, multiplier=${out.multiplier.toFixed(2)}, popularity=${Number.isFinite(out.popularity) ? out.popularity.toFixed(1) : "na"}, confidence=${out.confidence}`,
  };
}

async function repriceProduct(supabase, productId, context = {}) {
  if (!supabase || !productId) return { ok: false, error: "Missing supabase/productId" };
  const { data: p, error } = await supabase
    .from("products")
    .select("id, cost, price, views, clicks, orders_count, popularity_level")
    .eq("id", productId)
    .maybeSingle();
  if (error || !p) return { ok: false, error: error ? error.message : "Product not found" };
  const ctr = n(p.clicks) / Math.max(1, n(p.views));
  const cvr = n(p.orders_count) / Math.max(1, n(p.clicks));
  const out = computeOptimalPrice(
    { supplier_price: p.cost, market_price: p.price, confidence: "medium" },
    { ...context, ctr, cvr }
  );
  const { error: upErr } = await supabase
    .from("products")
    .update({ price: out.suggested_price, updated_at: new Date().toISOString() })
    .eq("id", productId);
  if (upErr) return { ok: false, error: upErr.message };
  return { ok: true, productId, ...out };
}

module.exports = {
  computeOptimalPrice,
  repriceProduct,
};
