function daysSince(ts) {
  const t = new Date(ts || 0).getTime();
  if (!Number.isFinite(t) || t <= 0) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

async function cleanupWeakProducts(supabase, products = [], weakProducts = [], opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const maxFraction = Math.min(0.2, Math.max(0.05, Number(opts.maxFraction) || 0.2));
  const minAgeDays = Math.max(7, Number(opts.minAgeDays) || 14);
  const cooldownHours = Math.max(24, Number(opts.cooldownHours) || 48);
  const cooldownMs = cooldownHours * 3600000;
  const now = Date.now();
  const weakSet = new Set((weakProducts || []).map((x) => x.id).filter(Boolean));

  const active = (products || []).filter((p) => p.status !== "removed" && p.status !== "inactive");
  const maxChanges = Math.max(1, Math.floor(active.length * maxFraction));

  const candidates = active
    .filter((p) => weakSet.has(p.id))
    .filter((p) => {
      const age = daysSince(p.created_at);
      if (age == null || age < minAgeDays) return false;
      const u = new Date(p.updated_at || 0).getTime();
      if (Number.isFinite(u) && u > 0 && now - u < cooldownMs) return false;
      return true;
    })
    .slice(0, maxChanges);

  if (dryRun) {
    return {
      removedCount: candidates.length,
      removedProducts: candidates.map((p) => ({ id: p.id, name: p.name || "", status: "inactive" })),
      wouldRemove: candidates.map((p) => ({ id: p.id, name: p.name || "", status: "inactive" })),
    };
  }

  const removedProducts = [];
  for (const p of candidates) {
    const { error } = await supabase
      .from("products")
      .update({ status: "inactive", updated_at: new Date().toISOString() })
      .eq("id", p.id)
      .neq("status", "removed");
    if (!error) removedProducts.push({ id: p.id, name: p.name || "", status: "inactive" });
  }

  return {
    removedCount: removedProducts.length,
    removedProducts,
    wouldRemove: removedProducts,
  };
}

async function boostStrongProducts(supabase, strongProducts = [], opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const boost = Math.max(2, Math.min(20, Number(opts.boost) || 8));
  const picks = (strongProducts || []).slice(0, Math.max(1, Number(opts.maxBoosted) || 40));
  if (dryRun) return { boostedCount: picks.length, boostedProducts: picks.map((p) => p.id) };
  let boostedCount = 0;
  for (const p of picks) {
    const { data, error } = await supabase.from("products").select("score").eq("id", p.id).maybeSingle();
    if (error || !data) continue;
    const next = Math.min(100, (Number(data.score) || 0) + boost);
    const { error: upErr } = await supabase.from("products").update({ score: next, updated_at: new Date().toISOString() }).eq("id", p.id);
    if (!upErr) boostedCount += 1;
  }
  return { boostedCount, boostedProducts: picks.map((p) => p.id) };
}

module.exports = { cleanupWeakProducts, boostStrongProducts };
