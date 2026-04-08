const { buildQueryFeedback } = require("../../ai-service/feedback-loop");
const logger = require("../../../lib/logger");
const { getSupabase } = require("../../../db/supabase");
const { getStoreConfig, updateStoreConfig } = require("../../../config/store-config");
const {
  normalizeQuery,
  buildQueryPerformanceMemory,
  buildCategoryPerformanceMemory,
} = require("../../discovery-intelligence");

const feedbackBuffer = [];

async function ingestFeedbackEvent(event) {
  const p = event && event.payload ? event.payload : {};
  feedbackBuffer.push({
    eventType: String(event && event.type ? event.type : "").trim(),
    productId: p.productId || null,
    sourceQuery: p.sourceQuery || "unknown",
    views: Number(p.views) || 0,
    clicks: Number(p.clicks) || 0,
    add_to_cart: Number(p.add_to_cart) || 0,
    orders: Number(p.orders) || 0,
    revenue: Number(p.revenue) || 0,
  });

  if (feedbackBuffer.length < 50) return;
  const batch = feedbackBuffer.splice(0, feedbackBuffer.length);
  const rewrites = buildQueryFeedback(batch);
  if (rewrites.length) {
    logger.info("ai.query_feedback.rewrites", { rewrites: rewrites.slice(0, 20) });
    try {
      const supabase = getSupabase();
      if (supabase) {
        const cfg = await getStoreConfig(supabase);
        const existing = Array.isArray(cfg.queryRewriteMemory) ? cfg.queryRewriteMemory : [];
        const byQuery = new Map(existing.map((x) => [String(x.query || "").trim().toLowerCase(), x]));
        const now = new Date().toISOString();
        for (const r of rewrites) {
          const q = String(r.query || "").trim().toLowerCase();
          if (!q) continue;
          byQuery.set(q, {
            query: q,
            suggestion: String(r.suggestion || "").trim(),
            score: Number(r.score) || 0,
            updatedAt: now,
          });
        }
        const merged = [...byQuery.values()]
          .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
          .slice(0, 200);
        await updateStoreConfig(supabase, { queryRewriteMemory: merged });
      }
    } catch (e) {
      logger.warn("ai.query_feedback.persist_failed", { error: e.message || String(e) });
    }
  }

  try {
    const supabase = getSupabase();
    if (!supabase) return;
    const ids = [...new Set(batch.map((x) => x.productId).filter(Boolean))];
    if (!ids.length) return;
    const { data: products } = await supabase
      .from("products")
      .select(
        "id, external_id, source_url, source_product_id, source_platform, source_name, source_query, discovery_mode, category, price, cost, unit_profit, estimated_shipping_cost, views, clicks, add_to_cart_count, orders_count, created_at"
      )
      .in("id", ids);
    if (!Array.isArray(products) || !products.length) return;

    const qHintByProduct = new Map();
    for (const row of batch) {
      if (!row.productId) continue;
      const q = normalizeQuery(row.sourceQuery);
      if (!q || q === "unknown") continue;
      if (!qHintByProduct.has(row.productId)) qHintByProduct.set(row.productId, q);
    }

    const now = new Date();
    const perfRows = products.map((pRow) => {
      const price = Number(pRow.price) || 0;
      const derivedUnitProfit =
        Number(pRow.unit_profit) ||
        Math.max(0, price - (Number(pRow.cost) || 0) - (Number(pRow.estimated_shipping_cost) || 0));
      const orders = Number(pRow.orders_count) || 0;
      const firstOrderAt = orders > 0 ? now.toISOString() : null;
      const tffs =
        orders > 0 && pRow.created_at
          ? Math.max(0, Math.round((now.getTime() - Date.parse(pRow.created_at)) / 1000))
          : null;
      return {
        discovery_key: String(pRow.external_id || pRow.source_url || pRow.id),
        product_id: pRow.id,
        external_id: pRow.external_id || null,
        source_url: pRow.source_url || null,
        source_product_id: pRow.source_product_id || null,
        source_platform: pRow.source_platform || "unknown",
        source_name: pRow.source_name || null,
        source_query: qHintByProduct.get(pRow.id) || String(pRow.source_query || ""),
        selection_mode: String(pRow.discovery_mode || "unknown"),
        query_confidence: "low",
        category: pRow.category || "other",
        views: Number(pRow.views) || 0,
        clicks: Number(pRow.clicks) || 0,
        add_to_cart: Number(pRow.add_to_cart_count) || 0,
        orders,
        revenue: Number((orders * price).toFixed(2)),
        unit_profit_total: Number((orders * derivedUnitProfit).toFixed(2)),
        first_order_at: firstOrderAt,
        time_to_first_sale_seconds: tffs,
        updated_at: now.toISOString(),
      };
    });
    await supabase.from("discovery_product_performance").upsert(perfRows, { onConflict: "discovery_key" });

    const { data: perfAll } = await supabase
      .from("discovery_product_performance")
      .select(
        "source_query, category, discoveries, views, clicks, add_to_cart, orders, revenue, unit_profit_total, time_to_first_sale_seconds, discovered_at, updated_at"
      )
      .order("updated_at", { ascending: false })
      .limit(3000);
    const queryPerformanceMemory = buildQueryPerformanceMemory(perfAll || []);
    const categoryPerformanceMemory = buildCategoryPerformanceMemory(perfAll || []);
    const cfg = await getStoreConfig(supabase);
    await updateStoreConfig(supabase, {
      queryPerformanceMemory,
      categoryPerformanceMemory,
    });
  } catch (e) {
    logger.warn("ai.discovery_feedback.persist_failed", { error: e.message || String(e) });
  }
}

module.exports = { ingestFeedbackEvent };
