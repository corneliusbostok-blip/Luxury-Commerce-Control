async function snapshotProducts(supabase, ids) {
  if (!supabase || !ids || !ids.length) return [];
  const uniq = [...new Set(ids.filter(Boolean))];
  const { data } = await supabase.from("products").select("*").in("id", uniq);
  return data || [];
}

async function restoreProducts(supabase, rows) {
  if (!supabase || !rows || !rows.length) return;
  const chunk = 50;
  for (let i = 0; i < rows.length; i += chunk) {
    await supabase.from("products").upsert(rows.slice(i, i + chunk), { onConflict: "id" });
  }
}

module.exports = {
  snapshotProducts,
  restoreProducts,
};
