function evaluateExperimentResults(products) {
  const groups = {
    A: { count: 0, orders: 0, revenue: 0, profit: 0 },
    B: { count: 0, orders: 0, revenue: 0, profit: 0 },
  };
  for (const p of products || []) {
    const v = String(p.experiment_variant || "").toUpperCase();
    if (v !== "A" && v !== "B") continue;
    const g = groups[v];
    const orders = Number(p.orders_count) || 0;
    const price = Number(p.price) || 0;
    const cost = Number(p.cost) || 0;
    g.count += 1;
    g.orders += orders;
    g.revenue += orders * price;
    g.profit += orders * Math.max(0, price - cost);
  }
  const scoreA = groups.A.profit + groups.A.revenue * 0.1;
  const scoreB = groups.B.profit + groups.B.revenue * 0.1;
  const winner = scoreA === scoreB ? null : scoreA > scoreB ? "A" : "B";
  const loser = winner === "A" ? "B" : winner === "B" ? "A" : null;
  return {
    groups,
    winner,
    loser,
    markDeprecateVariant: loser,
    autoPromoteVariant: winner,
  };
}

module.exports = {
  evaluateExperimentResults,
};
