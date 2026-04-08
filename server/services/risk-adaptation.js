const logger = require("../lib/logger");
const { getStoreConfig, updateStoreConfig } = require("../config/store-config");

const MIN_MULT = 0.65;
const MAX_MULT = 1.35;

function clampMult(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 1;
  return Math.max(MIN_MULT, Math.min(MAX_MULT, n));
}

function normalizeAdaptation(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    multiplier: clampMult(r.multiplier ?? 1),
    stableStreak: Math.max(0, Math.floor(Number(r.stableStreak) || 0)),
    unstableStreak: Math.max(0, Math.floor(Number(r.unstableStreak) || 0)),
    lastOutcome: r.lastOutcome != null ? String(r.lastOutcome) : "",
    lastDecisionQuality: Number(r.lastDecisionQuality) || null,
    updatedAt: r.updatedAt != null ? String(r.updatedAt) : "",
  };
}

/**
 * @param {object} prev
 * @param {'applied_ok'|'kill_switch'|'profit_kill'|'cycle_error'} outcome
 * @param {{ decisionQuality?: number }} [metrics]
 */
function computeNextAdaptation(prev, outcome, metrics = {}) {
  const cur = normalizeAdaptation(prev);
  let mult = cur.multiplier;
  let stable = cur.stableStreak;
  let unstable = cur.unstableStreak;

  const dq = Number(metrics.decisionQuality);
  const qualityOk = Number.isFinite(dq) && dq >= 52;

  if (outcome === "applied_ok") {
    unstable = 0;
    stable += 1;
    if (qualityOk && stable >= 2) {
      mult = Math.min(MAX_MULT, mult + 0.04);
      stable = 0;
    }
  } else if (outcome === "kill_switch" || outcome === "profit_kill" || outcome === "cycle_error") {
    stable = 0;
    unstable += 1;
    if (unstable >= 1) {
      mult = Math.max(MIN_MULT, mult - 0.1);
      if (outcome === "cycle_error" && unstable >= 2) {
        mult = Math.max(MIN_MULT, mult - 0.05);
      }
    }
  }

  return {
    multiplier: clampMult(mult),
    stableStreak: stable,
    unstableStreak: unstable,
    lastOutcome: outcome,
    lastDecisionQuality: Number.isFinite(dq) ? dq : cur.lastDecisionQuality,
    updatedAt: new Date().toISOString(),
  };
}

async function loadRiskAdaptMultiplier(supabase) {
  try {
    const cfg = await getStoreConfig(supabase);
    return normalizeAdaptation(cfg.riskAdaptation).multiplier;
  } catch (e) {
    logger.warn("risk_adaptation.load_failed", { error: e && e.message ? e.message : String(e) });
    return 1;
  }
}

async function persistRiskAdaptation(supabase, next) {
  if (!supabase) return;
  const payload = normalizeAdaptation(next);
  try {
    const saved = await updateStoreConfig(supabase, { riskAdaptation: payload });
    if (saved && saved.status === "error") {
      logger.warn("risk_adaptation.persist_failed", { reason: saved.reason });
    }
  } catch (e) {
    logger.warn("risk_adaptation.persist_error", { error: e && e.message ? e.message : String(e) });
  }
}

module.exports = {
  loadRiskAdaptMultiplier,
  persistRiskAdaptation,
  computeNextAdaptation,
  normalizeAdaptation,
  clampMult,
  MIN_MULT,
  MAX_MULT,
};
