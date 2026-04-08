"use strict";

const { normalizeCategoryId } = require("./category");

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function daysSince(ts) {
  const t = Date.parse(ts || 0);
  if (!t) return 9999;
  return Math.max(0, (Date.now() - t) / 86400000);
}

function normalizeQuery(q) {
  return String(q || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function asMap(rows, keyField) {
  const m = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const k = String(r && r[keyField] ? r[keyField] : "").trim().toLowerCase();
    if (!k) continue;
    m.set(k, r);
  }
  return m;
}

function queryPerformanceMap(storeConfig) {
  return asMap(storeConfig && storeConfig.queryPerformanceMemory, "query");
}

function categoryPerformanceMap(storeConfig) {
  return asMap(storeConfig && storeConfig.categoryPerformanceMemory, "category");
}

function computeDiscoveryScore(candidate, ctx = {}) {
  const row = candidate && typeof candidate === "object" ? candidate : {};
  const query = normalizeQuery(row.sourceQuery || row.source_query || ctx.query || "");
  const category = normalizeCategoryId(row.category || "other");
  const qMap = ctx.queryMap || new Map();
  const cMap = ctx.categoryMap || new Map();
  const qPerf = qMap.get(query) || null;
  const cPerf = cMap.get(category) || null;

  const baseHeuristics =
    (String(row.title || "").trim().length >= 8 ? 12 : 0) +
    (n(row.price) > 0 ? 15 : 0) +
    (String(row.image || "").trim() ? 18 : 0) +
    (String(row.sourceUrl || "").trim() ? 8 : 0);

  const qScore =
    n(qPerf && qPerf.score) * 0.5 +
    n(qPerf && qPerf.revenue_per_impression) * 22 +
    n(qPerf && qPerf.conversion_rate) * 260 +
    Math.max(0, n(qPerf && qPerf.avg_profit)) * 0.9;

  const cScore =
    n(cPerf && cPerf.score) * 0.55 +
    Math.max(0, n(cPerf && cPerf.profit_per_sku)) * 0.7 +
    n(cPerf && cPerf.sales_velocity) * 35;

  const discoveryScore = Number((baseHeuristics + qScore + cScore).toFixed(2));
  return {
    discovery_score: discoveryScore,
    query_weight: qPerf ? n(qPerf.score, 0) : 0,
    category_weight: cPerf ? n(cPerf.score, 0) : 0,
  };
}

function sortCandidatesByDiscoveryScore(rows, storeConfig) {
  const qMap = queryPerformanceMap(storeConfig);
  const cMap = categoryPerformanceMap(storeConfig);
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({ ...r, ...computeDiscoveryScore(r, { queryMap: qMap, categoryMap: cMap }) }))
    .sort((a, b) => n(b.discovery_score) - n(a.discovery_score));
}

async function recordDiscoveredCandidates(supabase, candidates = [], context = {}) {
  if (!supabase || !Array.isArray(candidates) || !candidates.length) return;
  const now = new Date().toISOString();
  const rows = [];
  for (const c of candidates) {
    const externalId = String(c.externalId || "").trim();
    const sourceUrl = String(c.sourceUrl || "").trim();
    if (!externalId && !sourceUrl) continue;
    rows.push({
      discovery_key: externalId || sourceUrl,
      external_id: externalId || null,
      source_url: sourceUrl || null,
      source_product_id: String(c.sourceProductId || "").trim() || null,
      source_platform: String(c.sourcePlatform || "").trim() || "unknown",
      source_name: String(c.sourceName || "").trim() || null,
      source_query: normalizeQuery(c.sourceQuery || c.source_query || context.sourceQuery || ""),
      selection_mode: String(c.discovery_selection_mode || "exploit"),
      query_confidence: String(c.discovery_query_confidence || "low"),
      category: normalizeCategoryId(c.category || "other"),
      discovery_score: n(c.discovery_score),
      discovered_at: now,
      updated_at: now,
      discoveries: 1,
    });
  }
  if (!rows.length) return;
  await supabase.from("discovery_product_performance").upsert(rows, { onConflict: "discovery_key" });
}

function buildQueryPerformanceMemory(rows = []) {
  const halfLifeDays = Math.max(3, Number(process.env.DISCOVERY_QUERY_DECAY_HALFLIFE_DAYS) || 21);
  const minSamples = Math.max(3, Number(process.env.DISCOVERY_MIN_SAMPLE_SIZE) || 8);
  const grouped = new Map();
  for (const r of rows) {
    const q = normalizeQuery(r.source_query || "");
    if (!q) continue;
    const cur = grouped.get(q) || {
      query: q,
      discoveries: 0,
      views: 0,
      clicks: 0,
      add_to_cart: 0,
      orders: 0,
      revenue: 0,
      unit_profit_total: 0,
    };
    const ageDays = daysSince(r.updated_at || r.discovered_at);
    const decay = Math.pow(0.5, ageDays / halfLifeDays);
    cur.discoveries += n(r.discoveries, 1) * decay;
    cur.views += n(r.views) * decay;
    cur.clicks += n(r.clicks) * decay;
    cur.add_to_cart += n(r.add_to_cart) * decay;
    cur.orders += n(r.orders) * decay;
    cur.revenue += n(r.revenue) * decay;
    cur.unit_profit_total += n(r.unit_profit_total) * decay;
    grouped.set(q, cur);
  }
  const now = new Date().toISOString();
  const out = [...grouped.values()].map((g) => {
    const avgProfit = g.discoveries > 0 ? g.unit_profit_total / g.discoveries : 0;
    const conversionRate = g.views > 0 ? g.orders / g.views : 0;
    const rpi = g.views > 0 ? g.revenue / g.views : 0;
    const sampleSize = Number(g.discoveries.toFixed(3));
    const confidence = sampleSize >= minSamples ? "high" : "low";
    const confidenceScale = confidence === "high" ? 1 : clamp(sampleSize / minSamples, 0.2, 0.95);
    const score = Number((confidenceScale * (avgProfit * 0.5 + conversionRate * 220 + rpi * 20)).toFixed(4));
    return {
      query: g.query,
      avg_profit: Number(avgProfit.toFixed(4)),
      conversion_rate: Number(conversionRate.toFixed(6)),
      revenue_per_impression: Number(rpi.toFixed(6)),
      score,
      sample_size: sampleSize,
      confidence,
      tier: "mid",
      updatedAt: now,
    };
  });
  out.sort((a, b) => n(b.score) - n(a.score));
  const top = out.slice(0, 40).map((x) => ({ ...x, tier: "top" }));
  const bottom = out.slice(-20).map((x) => ({ ...x, tier: "bottom" }));
  const merged = [...top, ...bottom];
  const uniq = new Map();
  for (const r of merged) uniq.set(r.query, r);
  return [...uniq.values()].slice(0, 80);
}

function buildCategoryPerformanceMemory(rows = []) {
  const halfLifeDays = Math.max(3, Number(process.env.DISCOVERY_CATEGORY_DECAY_HALFLIFE_DAYS) || 28);
  const minSamples = Math.max(3, Number(process.env.DISCOVERY_CATEGORY_MIN_SAMPLE_SIZE) || 6);
  const grouped = new Map();
  for (const r of rows) {
    const cat = normalizeCategoryId(r.category || "other");
    const cur = grouped.get(cat) || {
      category: cat,
      discoveries: 0,
      orders: 0,
      revenue: 0,
      unit_profit_total: 0,
      first_order_seconds_sum: 0,
      first_order_count: 0,
    };
    const ageDays = daysSince(r.updated_at || r.discovered_at);
    const decay = Math.pow(0.5, ageDays / halfLifeDays);
    cur.discoveries += n(r.discoveries, 1) * decay;
    cur.orders += n(r.orders) * decay;
    cur.revenue += n(r.revenue) * decay;
    cur.unit_profit_total += n(r.unit_profit_total) * decay;
    const tffs = n(r.time_to_first_sale_seconds, 0);
    if (tffs > 0) {
      cur.first_order_seconds_sum += tffs;
      cur.first_order_count += 1;
    }
    grouped.set(cat, cur);
  }
  const now = new Date().toISOString();
  return [...grouped.values()]
    .map((g) => {
      const profitPerSku = g.discoveries > 0 ? g.unit_profit_total / g.discoveries : 0;
      const salesVelocity = g.discoveries > 0 ? g.orders / g.discoveries : 0;
      const avgTffsHours = g.first_order_count > 0 ? g.first_order_seconds_sum / g.first_order_count / 3600 : null;
      const speedBoost = avgTffsHours && avgTffsHours > 0 ? Math.max(0, 24 / avgTffsHours) : 0;
      const sampleSize = Number(g.discoveries.toFixed(3));
      const confidence = sampleSize >= minSamples ? "high" : "low";
      const confidenceScale = confidence === "high" ? 1 : clamp(sampleSize / minSamples, 0.25, 0.95);
      const score = Number((confidenceScale * (profitPerSku * 0.6 + salesVelocity * 140 + speedBoost * 6)).toFixed(4));
      return {
        category: g.category,
        profit_per_sku: Number(profitPerSku.toFixed(4)),
        sales_velocity: Number(salesVelocity.toFixed(6)),
        avg_time_to_first_sale_hours: avgTffsHours == null ? null : Number(avgTffsHours.toFixed(3)),
        score,
        sample_size: sampleSize,
        confidence,
        updatedAt: now,
      };
    })
    .sort((a, b) => n(b.score) - n(a.score))
    .slice(0, 40);
}

module.exports = {
  normalizeQuery,
  queryPerformanceMap,
  categoryPerformanceMap,
  computeDiscoveryScore,
  sortCandidatesByDiscoveryScore,
  recordDiscoveredCandidates,
  buildQueryPerformanceMemory,
  buildCategoryPerformanceMemory,
};

