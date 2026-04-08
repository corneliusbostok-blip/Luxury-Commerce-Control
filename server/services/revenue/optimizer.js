function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
const { computeOptimalPrice } = require("../pricing/price-engine");

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function classifyProducts(products = []) {
  const winners = [];
  const potential = [];
  const losers = [];

  for (const p of products) {
    const views = n(p.views);
    const clicks = n(p.clicks);
    const orders = n(p.orders_count);
    const price = n(p.price);
    const ctr = views > 0 ? clicks / views : 0;
    const cvr = clicks > 0 ? orders / clicks : 0;
    const revenue = orders * price;
    const row = { id: p.id, name: p.name || "", ctr, cvr, revenue, views, clicks, orders, price };

    if (orders > 5 && cvr > 0.02) winners.push(row);
    else if (ctr > 0.03 && cvr < 0.02) potential.push(row);
    else if (views > 50 && orders === 0) losers.push(row);
  }

  return { winners, potential, losers };
}

async function optimizeRevenueCatalog(supabase, products = [], opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const skipLosers = Boolean(opts.skipLosers);
  const maxFraction = Math.min(0.2, Math.max(0.05, Number(opts.maxFraction) || 0.2));
  const active = (products || []).filter((p) => p.status !== "removed" && p.status !== "inactive");
  const limit = Math.max(1, Math.floor(active.length * maxFraction));
  const { winners, potential, losers } = classifyProducts(active);
  const policy = opts && opts.policy && typeof opts.policy === "object" ? opts.policy : {};
  const baseGoal = String(policy.goal || "profit").toLowerCase().includes("growth") ? "growth" : "profit";
  const riskLevel = String(policy.risk || "balanced");

  const optimized = [];
  const flaggedForRemoval = [];
  let changes = 0;

  // Winners/potential repricing now uses shared pricing policy.
  for (const w of winners) {
    if (changes >= limit) break;
    const priced = computeOptimalPrice(
      {
        supplier_price: n((active.find((p) => p.id === w.id) || {}).cost),
        market_price: w.price,
        estimated_shipping_cost: n((active.find((p) => p.id === w.id) || {}).estimated_shipping_cost),
        confidence: "high",
      },
      { goal: baseGoal, riskLevel, ctr: w.ctr, cvr: w.cvr }
    );
    const nextPrice = round2(Number(priced.suggested_price) || w.price);
    const update = { id: w.id, action: "winner_boost", oldPrice: w.price, newPrice: nextPrice };
    if (!dryRun && supabase) {
      const { error } = await supabase
        .from("products")
        .update({ price: nextPrice, score: Math.min(100, n((active.find((p) => p.id === w.id) || {}).score) + 8), updated_at: new Date().toISOString() })
        .eq("id", w.id);
      if (error) continue;
    }
    optimized.push(update);
    changes += 1;
  }

  // Potential repricing also uses shared pricing policy.
  for (const p of potential) {
    if (changes >= limit) break;
    if (optimized.some((x) => x.id === p.id)) continue;
    const priced = computeOptimalPrice(
      {
        supplier_price: n((active.find((x) => x.id === p.id) || {}).cost),
        market_price: p.price,
        estimated_shipping_cost: n((active.find((x) => x.id === p.id) || {}).estimated_shipping_cost),
        confidence: "medium",
      },
      { goal: baseGoal, riskLevel, ctr: p.ctr, cvr: p.cvr }
    );
    const nextPrice = round2(Number(priced.suggested_price) || p.price);
    const update = { id: p.id, action: "potential_reprice", oldPrice: p.price, newPrice: nextPrice };
    if (!dryRun && supabase) {
      const { error } = await supabase
        .from("products")
        .update({ price: nextPrice, updated_at: new Date().toISOString() })
        .eq("id", p.id);
      if (error) continue;
    }
    optimized.push(update);
    changes += 1;
  }

  // Losers: flag/remove (inactive)
  if (!skipLosers) {
    for (const l of losers) {
      if (changes >= limit) break;
      if (optimized.some((x) => x.id === l.id)) continue;
      const item = { id: l.id, action: "flag_for_removal", reason: "high_views_no_orders" };
      if (!dryRun && supabase) {
        const { error } = await supabase
          .from("products")
          .update({ status: "inactive", updated_at: new Date().toISOString() })
          .eq("id", l.id)
          .neq("status", "removed");
        if (error) continue;
      }
      flaggedForRemoval.push(item);
      changes += 1;
    }
  }

  return {
    winners,
    optimized,
    flaggedForRemoval,
  };
}

module.exports = {
  optimizeRevenueCatalog,
  classifyProducts,
};
