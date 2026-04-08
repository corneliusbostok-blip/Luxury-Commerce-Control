let lastParams = null;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function ema(next, prev, alpha) {
  return prev == null ? next : prev * (1 - alpha) + next * alpha;
}

function tuneParametersFromTrends(trends) {
  const rows = trends || [];
  if (rows.length < 2) {
    const base = {
      pricingAggressiveness: 1,
      sourcingAggressiveness: 0.2,
      removalThresholdFactor: 1,
      stability: "normal",
    };
    lastParams = lastParams || base;
    return lastParams;
  }
  const latest = rows[0];
  const prevRow = rows[1];
  const profitNow = Number(latest.profit) || 0;
  const profitPrev = Number(prevRow.profit) || 0;
  const delta = profitNow - profitPrev;
  let target;
  if (rows.length < 5) {
    target = {
      pricingAggressiveness: 1,
      sourcingAggressiveness: 0.2,
      removalThresholdFactor: 1,
      stability: "warmup",
    };
  } else if (delta < 0) {
    target = {
      pricingAggressiveness: 0.92,
      sourcingAggressiveness: 0.24,
      removalThresholdFactor: 0.85,
      stability: "defensive",
    };
  } else {
    target = {
      pricingAggressiveness: 1.05,
      sourcingAggressiveness: 0.18,
      removalThresholdFactor: 1.08,
      stability: "offensive",
    };
  }
  const prev = lastParams || {
    pricingAggressiveness: 1,
    sourcingAggressiveness: 0.2,
    removalThresholdFactor: 1,
    stability: "normal",
  };
  const smoothed = {
    pricingAggressiveness: clamp(ema(target.pricingAggressiveness, prev.pricingAggressiveness, 0.35), prev.pricingAggressiveness - 0.08, prev.pricingAggressiveness + 0.08),
    sourcingAggressiveness: clamp(ema(target.sourcingAggressiveness, prev.sourcingAggressiveness, 0.35), prev.sourcingAggressiveness - 0.04, prev.sourcingAggressiveness + 0.04),
    removalThresholdFactor: clamp(ema(target.removalThresholdFactor, prev.removalThresholdFactor, 0.35), prev.removalThresholdFactor - 0.08, prev.removalThresholdFactor + 0.08),
    stability: target.stability,
  };
  lastParams = smoothed;
  return smoothed;
}

module.exports = {
  tuneParametersFromTrends,
};
