function computeStrategyState(products, tunedParams) {
  const active = (products || []).filter((p) => p.status !== "removed");
  const exploreBase = Number((tunedParams && tunedParams.sourcingAggressiveness) || 0.2);
  const exploreRatio = Math.max(0.1, Math.min(0.35, active.length < 12 ? exploreBase + 0.05 : exploreBase));
  return {
    exploreRatio,
    exploitRatio: Math.max(0, 1 - exploreRatio),
  };
}

module.exports = {
  computeStrategyState,
};
