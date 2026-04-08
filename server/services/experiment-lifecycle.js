const MIN_WINDOW_HOURS = Math.max(6, Number(process.env.EXPERIMENT_MIN_WINDOW_HOURS) || 48);
const MIN_SAMPLE_SIZE = Math.max(10, Number(process.env.EXPERIMENT_MIN_SAMPLE) || 40);

async function startExperiment(supabase, payload) {
  if (!supabase) return null;
  const row = {
    experiment_key: payload.experiment_key,
    variant_a: payload.variant_a || "A",
    variant_b: payload.variant_b || "B",
    status: "running",
    started_at: new Date().toISOString(),
    context: payload.context || {},
  };
  const { data } = await supabase.from("experiments").insert(row).select("*").maybeSingle();
  return data || null;
}

function shouldCloseExperiment(exp, metrics) {
  if (!exp) return false;
  const started = exp.started_at ? new Date(exp.started_at).getTime() : Date.now();
  const ageHours = (Date.now() - started) / 3600000;
  const sample = Number(metrics && metrics.sampleSize) || 0;
  return ageHours >= MIN_WINDOW_HOURS && sample >= MIN_SAMPLE_SIZE;
}

async function closeExperiment(supabase, expId, winner, reason) {
  if (!supabase || !expId) return;
  await supabase
    .from("experiments")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
      winner_variant: winner || null,
      close_reason: reason || null,
    })
    .eq("id", expId);
}

async function archiveExperimentResult(supabase, row) {
  if (!supabase) return;
  await supabase.from("experiment_results").insert({
    experiment_id: row.experiment_id || null,
    winner_variant: row.winner_variant || null,
    loser_variant: row.loser_variant || null,
    evidence: row.evidence || {},
    created_at: new Date().toISOString(),
  });
}

module.exports = {
  startExperiment,
  shouldCloseExperiment,
  closeExperiment,
  archiveExperimentResult,
};
