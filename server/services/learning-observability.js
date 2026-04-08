"use strict";

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function todayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function toProfitPerSku(totalProfit, activeCount) {
  return activeCount > 0 ? Number((totalProfit / activeCount).toFixed(4)) : 0;
}

function computeGroupPerformance(rows = []) {
  let revenue = 0;
  let profit = 0;
  let views = 0;
  let orders = 0;
  let count = 0;
  for (const p of rows) {
    const price = n(p.price);
    const unitProfit = n(p.unit_profit, price - n(p.cost) - n(p.estimated_shipping_cost) - n(p.return_risk_proxy));
    const o = n(p.orders_count);
    const v = n(p.views);
    revenue += o * price;
    profit += o * Math.max(0, unitProfit);
    orders += o;
    views += v;
    count += 1;
  }
  const conversionRate = views > 0 ? Number((orders / views).toFixed(6)) : 0;
  const profitPerSku = count > 0 ? Number((profit / count).toFixed(4)) : 0;
  const roi = revenue > 0 ? Number((profit / revenue).toFixed(6)) : 0;
  return {
    count,
    revenue: Number(revenue.toFixed(2)),
    profit: Number(profit.toFixed(2)),
    conversionRate,
    profitPerSku,
    roi,
  };
}

async function computeDecisionAccuracy(supabase) {
  if (!supabase) return 0;
  try {
    const { data: decisions, error } = await supabase
      .from("decision_ledger")
      .select("cycle_id, before_state, after_state, created_at")
      .order("created_at", { ascending: false })
      .limit(400);
    if (error || !Array.isArray(decisions) || !decisions.length) return 0;

    const cycleIds = [...new Set(decisions.map((d) => String(d.cycle_id || "").trim()).filter(Boolean))].slice(0, 80);
    let cycleMap = new Map();
    if (cycleIds.length) {
      const { data: outcomes } = await supabase
        .from("cycle_outcomes")
        .select("cycle_id, profit_delta")
        .in("cycle_id", cycleIds);
      cycleMap = new Map((outcomes || []).map((r) => [String(r.cycle_id || ""), n(r.profit_delta)]));
    }

    let samples = 0;
    let scoreSum = 0;
    for (const d of decisions) {
      const b = d.before_state && typeof d.before_state === "object" ? d.before_state : {};
      const a = d.after_state && typeof d.after_state === "object" ? d.after_state : {};
      const expected =
        n(a.expected_profit_impact, NaN) ||
        n(a.profit_impact, NaN) ||
        n(b.expected_profit_impact, NaN) ||
        n(b.profit_impact, NaN);
      let actual =
        n(a.actual_profit_impact, NaN) ||
        n(a.realized_profit_impact, NaN) ||
        n(b.actual_profit_impact, NaN);
      if (!Number.isFinite(actual)) {
        const cycleDelta = cycleMap.get(String(d.cycle_id || ""));
        if (Number.isFinite(cycleDelta)) actual = cycleDelta;
      }
      if (!Number.isFinite(expected) || !Number.isFinite(actual)) continue;
      const denom = Math.max(1, Math.abs(expected));
      const normalizedError = Math.min(1.5, Math.abs(actual - expected) / denom);
      const signBonus = expected === 0 || actual === 0 ? 0 : Math.sign(expected) === Math.sign(actual) ? 0.2 : -0.2;
      const acc = Math.max(0, Math.min(1, 1 - normalizedError + signBonus));
      scoreSum += acc;
      samples += 1;
    }
    return samples > 0 ? Number((scoreSum / samples).toFixed(6)) : 0;
  } catch {
    return 0;
  }
}

async function recordLearningMetrics(supabase, products = []) {
  if (!supabase) return null;
  const live = (products || []).filter((p) => String(p.status || "").toLowerCase() !== "removed");
  const active = live.filter(
    (p) =>
      String(p.status || "").toLowerCase() !== "inactive" &&
      (p.sourcing_status === "approved" || p.sourcing_status == null || p.sourcing_status === "")
  );
  const totalPerf = computeGroupPerformance(active);

  const exploreRows = active.filter((p) => String(p.discovery_mode || "unknown") === "explore");
  const exploitRows = active.filter((p) => String(p.discovery_mode || "unknown") === "exploit");
  const fallbackRows = active.filter((p) => String(p.import_method || "").includes("fallback"));
  const normalRows = active.filter((p) => !String(p.import_method || "").includes("fallback"));

  const explorePerf = computeGroupPerformance(exploreRows);
  const exploitPerf = computeGroupPerformance(exploitRows);
  const fallbackPerf = computeGroupPerformance(fallbackRows);
  const normalPerf = computeGroupPerformance(normalRows);
  const decisionAccuracy = await computeDecisionAccuracy(supabase);

  const row = {
    date: todayDateKey(),
    total_profit: totalPerf.profit,
    active_product_count: totalPerf.count,
    profit_per_sku: toProfitPerSku(totalPerf.profit, totalPerf.count),
    explore_revenue: explorePerf.revenue,
    explore_profit: explorePerf.profit,
    explore_conversion_rate: explorePerf.conversionRate,
    exploit_revenue: exploitPerf.revenue,
    exploit_profit: exploitPerf.profit,
    exploit_conversion_rate: exploitPerf.conversionRate,
    explore_roi: explorePerf.roi,
    exploit_roi: exploitPerf.roi,
    decision_accuracy: decisionAccuracy,
    fallback_profit_per_sku: fallbackPerf.profitPerSku,
    fallback_conversion_rate: fallbackPerf.conversionRate,
    normal_profit_per_sku: normalPerf.profitPerSku,
    normal_conversion_rate: normalPerf.conversionRate,
    updated_at: new Date().toISOString(),
  };
  await supabase.from("learning_metrics_daily").upsert(row, { onConflict: "date" });
  return row;
}

function velocityFromSeries(rows, days) {
  const list = (rows || []).slice(0, days).filter((r) => Number.isFinite(Number(r.profit_per_sku)));
  if (list.length < 2) return 0;
  const newest = Number(list[0].profit_per_sku) || 0;
  const oldest = Number(list[list.length - 1].profit_per_sku) || 0;
  const span = Math.max(1, list.length - 1);
  return Number(((newest - oldest) / span).toFixed(6));
}

async function getLearningMetricsSummary(supabase) {
  if (!supabase) {
    return {
      profit_per_sku: 0,
      learning_velocity: { last7d: 0, last30d: 0 },
      explore_vs_exploit: {},
      decision_accuracy: 0,
      fallback_performance: {},
      series: [],
    };
  }
  try {
    const { data, error } = await supabase
      .from("learning_metrics_daily")
      .select("*")
      .order("date", { ascending: false })
      .limit(30);
    if (error || !Array.isArray(data) || !data.length) {
      return {
        profit_per_sku: 0,
        learning_velocity: { last7d: 0, last30d: 0 },
        explore_vs_exploit: {},
        decision_accuracy: 0,
        fallback_performance: {},
        series: [],
      };
    }
    const latest = data[0];
    return {
      profit_per_sku: n(latest.profit_per_sku),
      learning_velocity: {
        last7d: velocityFromSeries(data, 7),
        last30d: velocityFromSeries(data, 30),
      },
      explore_vs_exploit: {
        explore: {
          revenue: n(latest.explore_revenue),
          profit: n(latest.explore_profit),
          conversion_rate: n(latest.explore_conversion_rate),
          roi: n(latest.explore_roi),
        },
        exploit: {
          revenue: n(latest.exploit_revenue),
          profit: n(latest.exploit_profit),
          conversion_rate: n(latest.exploit_conversion_rate),
          roi: n(latest.exploit_roi),
        },
      },
      decision_accuracy: n(latest.decision_accuracy),
      fallback_performance: {
        fallback: {
          profit_per_sku: n(latest.fallback_profit_per_sku),
          conversion_rate: n(latest.fallback_conversion_rate),
        },
        normal: {
          profit_per_sku: n(latest.normal_profit_per_sku),
          conversion_rate: n(latest.normal_conversion_rate),
        },
      },
      series: data.map((r) => ({
        date: r.date,
        profit_per_sku: n(r.profit_per_sku),
        decision_accuracy: n(r.decision_accuracy),
      })),
    };
  } catch {
    return {
      profit_per_sku: 0,
      learning_velocity: { last7d: 0, last30d: 0 },
      explore_vs_exploit: {},
      decision_accuracy: 0,
      fallback_performance: {},
      series: [],
    };
  }
}

module.exports = {
  recordLearningMetrics,
  getLearningMetricsSummary,
};

