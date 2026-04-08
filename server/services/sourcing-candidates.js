async function createSourcingCandidate(supabase, payload) {
  if (!supabase) return { ok: false, error: "Database not configured" };
  const row = {
    status: "pending",
    decision_reason: payload.decisionReason || "",
    source_platform: payload.sourcePlatform || "",
    source_query: payload.sourceQuery || "",
    ai_score: Number(payload.aiScore) || 0,
    risk_score: Number(payload.riskScore) || 0,
    ranking_score: Number(payload.rankingScore) || 0,
    candidate_payload: payload.candidatePayload || {},
  };
  const { data, error } = await supabase.from("sourcing_candidates").insert(row).select("*").single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, candidate: data };
}

async function listPendingSourcingCandidates(supabase, limit = 100) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("sourcing_candidates")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(500, Number(limit) || 100)));
  if (error) return [];
  return (data || []).map((row) => {
    const payload = row && row.candidate_payload && typeof row.candidate_payload === "object" ? row.candidate_payload : {};
    const r = payload && payload.row && typeof payload.row === "object" ? payload.row : {};
    return {
      ...row,
      popularity_level: r.popularity_level || "unknown",
      sold_count: Number.isFinite(Number(r.sold_count)) ? Number(r.sold_count) : null,
      review_count: Number.isFinite(Number(r.review_count)) ? Number(r.review_count) : null,
    };
  });
}

async function updateSourcingCandidateDecision(supabase, id, decision) {
  if (!supabase) return { ok: false, error: "Database not configured" };
  const patch = {
    status: decision.status,
    decision_reason: decision.reason || "",
    reviewed_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from("sourcing_candidates")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, candidate: data };
}

module.exports = {
  createSourcingCandidate,
  listPendingSourcingCandidates,
  updateSourcingCandidateDecision,
};
