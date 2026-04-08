async function logProductTransition(supabase, payload) {
  if (!supabase || !payload || !payload.product_id) return;
  const row = {
    product_id: String(payload.product_id),
    from_status: payload.from_status || null,
    to_status: payload.to_status || null,
    from_sourcing: payload.from_sourcing || null,
    to_sourcing: payload.to_sourcing || null,
    reason: payload.reason || null,
    actor_type: payload.actor_type || "system",
    actor_id: payload.actor_id || null,
    cycle_id: payload.cycle_id || null,
    created_at: new Date().toISOString(),
  };
  try {
    await supabase.from("product_state_transitions").insert(row);
  } catch {
    // Keep runtime stable even if migration is not applied yet.
  }
}

module.exports = {
  logProductTransition,
};
