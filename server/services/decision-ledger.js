async function recordDecision(supabase, row) {
  if (!supabase || !row) return;
  const payload = {
    cycle_id: row.cycle_id || null,
    decision_type: row.decision_type || "unknown",
    product_id: row.product_id || null,
    category: row.category || null,
    source_name: row.source_name || null,
    hypothesis: row.hypothesis || null,
    expected_effect: row.expected_effect || null,
    confidence: row.confidence != null ? Number(row.confidence) : null,
    before_state: row.before_state || null,
    after_state: row.after_state || null,
    created_at: new Date().toISOString(),
  };
  try {
    await supabase.from("decision_ledger").insert(payload);
  } catch {
    // keep runtime stable when migration is not applied
  }
}

async function loadRecentDecisions(supabase, limit = 50) {
  if (!supabase) return [];
  try {
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const { data, error } = await supabase
      .from("decision_ledger")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(lim);
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

module.exports = {
  recordDecision,
  loadRecentDecisions,
};
