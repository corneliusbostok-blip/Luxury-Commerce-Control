async function logEventToAiLog(supabase, event) {
  if (!supabase || !event) return;
  const payload = event.payload || {};
  try {
    await supabase.from("ai_log").insert({
      action: `event_${event.type}`,
      details: payload,
      metadata: payload,
      created_at: event.timestamp || new Date().toISOString(),
    });
  } catch {
    // no-op
  }
}

module.exports = { logEventToAiLog };
