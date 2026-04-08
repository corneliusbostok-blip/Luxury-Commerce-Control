const logger = require("../../lib/logger");
const { runAutomationCycle, getAutomationState } = require("../../automation");
const AI_CEO_RUNTIME_VERSION = "v2-delegated-execution";
console.log("AI CEO VERSION:", AI_CEO_RUNTIME_VERSION);

async function runAiCeoCycle({ supabase, dryRun = false, mode = "full" } = {}) {
  if (!supabase) return { ok: false, error: "Database not configured" };
  const startedAt = new Date().toISOString();
  logger.info("ai_ceo.cycle.started", { dryRun, mode, startedAt });

  const startMs = Date.now();
  const out = {
    ok: true,
    dryRun: Boolean(dryRun),
    mode,
    status: "ok",
    source: "delegated-automation",
    authority: "automation_cycle",
    version: AI_CEO_RUNTIME_VERSION,
    summary: {},
    errors: [],
  };

  if (!dryRun) {
    try {
      await runAutomationCycle(supabase, { mode });
    } catch (e) {
      out.ok = false;
      out.status = "error";
      out.errors.push({ step: "execute", error: e.message || String(e) });
    }
  }
  const auto = getAutomationState();
  out.summary.execution = {
    running: Boolean(auto.running),
    lastRunAt: auto.lastRunAt || null,
    lastError: auto.lastError || null,
    productsAddedLastRun: Number(auto.productsAddedLastRun) || 0,
    productsRemovedLastRun: Number(auto.productsRemovedLastRun) || 0,
    decisionsApplied: Array.isArray(auto.decisionsLastRun) ? auto.decisionsLastRun.length : 0,
  };
  if (dryRun) {
    out.status = "no_results";
    out.summary.note =
      "Dry-run preview is not supported in ai-ceo controller. Decision authority is delegated to automation execution only.";
  }

  const discoverySkipped = String(mode || "full").toLowerCase() === "light";
  out.summary = {
    ...(out.summary || {}),
    mode,
    discoverySkipped,
    removedCount: out.summary.execution.productsRemovedLastRun || 0,
    addedCount: out.summary.execution.productsAddedLastRun || 0,
    priceChanges: (out.summary.execution.decisionsApplied || 0),
    boostedCount: 0,
    errors: out.errors.length,
    durationMs: Date.now() - startMs,
  };

  if (!dryRun) {
    try {
      await supabase.from("ai_ceo_runs").insert({
        mode,
        summary: {
          mode,
          discoverySkipped: out.summary.discoverySkipped,
          removedCount: out.summary.removedCount,
          addedCount: out.summary.addedCount,
          priceChanges: out.summary.priceChanges,
          errors: out.errors || [],
          durationMs: out.summary.durationMs,
        },
      });
    } catch (e) {
      logger.warn("ai_ceo.run.persist_failed", { error: e.message || String(e) });
    }
  }

  logger.info("ai_ceo.cycle.completed", {
    dryRun,
    mode,
    summary: out.summary,
    startedAt,
    completedAt: new Date().toISOString(),
  });
  return out;
}

module.exports = { runAiCeoCycle };
