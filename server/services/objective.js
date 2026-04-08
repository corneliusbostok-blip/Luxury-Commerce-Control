function computeObjective(storeMetrics) {
  return Number(storeMetrics && storeMetrics.totalProfit) || 0;
}

function evaluateDelta(beforeMetrics, afterMetrics) {
  const before = Number(beforeMetrics && beforeMetrics.totalProfit) || 0;
  const after = Number(afterMetrics && afterMetrics.totalProfit) || 0;
  return after - before;
}

module.exports = {
  computeObjective,
  evaluateDelta,
};
