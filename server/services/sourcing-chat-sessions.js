async function getSourcingChatSession(supabase, sessionId) {
  if (!supabase || !sessionId) return null;
  const { data, error } = await supabase
    .from("sourcing_chat_sessions")
    .select("session_id, raw_candidate, eval_result, last_hint, last_category_intent, updated_at")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    raw: data.raw_candidate || null,
    evalResult: data.eval_result || null,
    lastHint: data.last_hint || "",
    lastCategoryIntent: data.last_category_intent || null,
    updatedAt: data.updated_at || null,
  };
}

async function upsertSourcingChatSession(supabase, sessionId, payload) {
  if (!supabase || !sessionId) return;
  await supabase.from("sourcing_chat_sessions").upsert(
    {
      session_id: sessionId,
      raw_candidate: payload.raw || {},
      eval_result: payload.evalResult || {},
      last_hint: payload.lastHint || "",
      last_category_intent: payload.lastCategoryIntent || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "session_id" }
  );
}

async function deleteSourcingChatSession(supabase, sessionId) {
  if (!supabase || !sessionId) return;
  await supabase.from("sourcing_chat_sessions").delete().eq("session_id", sessionId);
}

module.exports = {
  getSourcingChatSession,
  upsertSourcingChatSession,
  deleteSourcingChatSession,
};
