"use strict";

const { computeFulfillmentPriority, priorityBandFromScore } = require("./priority");

/**
 * DB helpers for fulfillment_queue (eBay inbox).
 */

async function insertEbayFulfillmentQueueIfPending(supabase, row) {
  if (!supabase || !row) return { inserted: false, skipped: true, reason: "no_db" };
  const orderId = String(row.order_id || "").trim();
  const productId = String(row.product_id || "").trim();
  if (!orderId || !productId) return { inserted: false, skipped: true, reason: "missing_ids" };

  const { data: existing, error: exErr } = await supabase
    .from("fulfillment_queue")
    .select("id")
    .eq("order_id", orderId)
    .eq("product_id", productId)
    .eq("status", "pending")
    .maybeSingle();
  if (exErr) throw exErr;
  if (existing && existing.id) {
    return { inserted: false, id: existing.id, skipped: true, reason: "already_pending" };
  }

  const { data, error } = await supabase
    .from("fulfillment_queue")
    .insert({
      order_id: orderId,
      product_id: productId,
      supplier: "ebay",
      status: "pending",
      supplier_url: String(row.supplier_url || ""),
      variant_data: row.variant_data && typeof row.variant_data === "object" ? row.variant_data : {},
      customer_data: row.customer_data && typeof row.customer_data === "object" ? row.customer_data : {},
    })
    .select("id")
    .single();
  if (error) {
    if (String(error.code || "") === "23505") {
      return { inserted: false, skipped: true, reason: "already_pending" };
    }
    throw error;
  }
  return { inserted: true, id: data.id, skipped: false };
}

async function listFulfillmentQueue(supabase, opts = {}) {
  if (!supabase) return { ok: false, error: "Database not configured", items: [] };
  const status = opts.status != null ? String(opts.status).trim().toLowerCase() : "";
  let q = supabase.from("fulfillment_queue").select("*").order("created_at", { ascending: false });
  if (status && ["pending", "completed", "failed"].includes(status)) {
    q = q.eq("status", status);
  }
  const { data, error } = await q;
  if (error) throw error;
  return { ok: true, items: data || [] };
}

async function listFulfillmentQueueWithPriority(supabase, opts = {}) {
  const out = await listFulfillmentQueue(supabase, opts);
  const items = out.items || [];
  if (!items.length) return { ok: true, items: [] };

  const productIds = [...new Set(items.map((i) => String(i.product_id || "").trim()).filter(Boolean))];
  const orderIds = [...new Set(items.map((i) => String(i.order_id || "").trim()).filter(Boolean))];

  const productMap = new Map();
  const orderMap = new Map();

  if (productIds.length) {
    const { data: prows, error: pErr } = await supabase
      .from("products")
      .select(
        "id,price,cost,estimated_shipping_cost,return_risk_proxy,ai_fit_score,available,supplier_sync_error"
      )
      .in("id", productIds);
    if (pErr) throw pErr;
    (prows || []).forEach((p) => productMap.set(String(p.id), p));
  }
  if (orderIds.length) {
    const { data: orows, error: oErr } = await supabase
      .from("orders")
      .select("id,amount_cents,currency,line_items")
      .in("id", orderIds);
    if (oErr) throw oErr;
    (orows || []).forEach((o) => orderMap.set(String(o.id), o));
  }

  const enriched = items.map((item) => {
    const pid = String(item.product_id || "").trim();
    const oid = String(item.order_id || "").trim();
    const product = productMap.get(pid) || null;
    const order = orderMap.get(oid) || null;
    const pr = computeFulfillmentPriority(item, { product, order });
    const band = priorityBandFromScore(pr.score);
    return {
      ...item,
      priority_score: pr.score,
      priority_reasons: pr.reasons,
      priority_band: band.band,
      priority_label: band.label,
    };
  });

  enriched.sort((a, b) => Number(b.priority_score) - Number(a.priority_score));
  return { ok: true, items: enriched };
}

async function markFulfillmentQueueCompleted(supabase, id) {
  if (!supabase) return { ok: false, error: "Database not configured" };
  const rid = String(id || "").trim();
  if (!rid) return { ok: false, error: "Invalid id" };
  const { data, error } = await supabase
    .from("fulfillment_queue")
    .update({ status: "completed" })
    .eq("id", rid)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, error: "Not found or not pending" };
  return { ok: true, id: data.id };
}

module.exports = {
  insertEbayFulfillmentQueueIfPending,
  listFulfillmentQueue,
  listFulfillmentQueueWithPriority,
  markFulfillmentQueueCompleted,
};
