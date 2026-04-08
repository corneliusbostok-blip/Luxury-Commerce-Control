const logger = require("../../lib/logger");
const { acquireLock, releaseLock } = require("../automation-lock");
const { insertEbayFulfillmentQueueIfPending } = require("./fulfillment-queue");

function asObj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function lineQty(line) {
  return Math.max(1, Number(line && line.quantity) || 1);
}

/** Routes fulfillment: Shopify → webhook (unchanged); eBay → fulfillment_queue inbox. */
function fulfillmentSupplierBucket(platformRaw) {
  const p = String(platformRaw || "").toLowerCase();
  if (p.includes("shopify")) return "shopify";
  if (p === "ebay" || p.includes("ebay")) return "ebay";
  return null;
}

function platformWebhookUrl(platform) {
  const p = String(platform || "").trim().toUpperCase();
  if (!p) return String(process.env.SUPPLIER_ORDER_WEBHOOK_URL || "").trim();
  const specific = String(process.env["SUPPLIER_ORDER_WEBHOOK_" + p] || "").trim();
  return specific || String(process.env.SUPPLIER_ORDER_WEBHOOK_URL || "").trim();
}

async function postSupplierOrder(url, payload) {
  const f = typeof fetch === "function" ? fetch : null;
  if (!f) throw new Error("Global fetch is unavailable in this Node runtime");
  const token = String(process.env.SUPPLIER_ORDER_WEBHOOK_TOKEN || "").trim();
  const headers = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await f(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = body && (body.error || body.message) ? String(body.error || body.message) : "supplier_webhook_failed";
    throw new Error(err + " (status " + res.status + ")");
  }
  return body || {};
}

function mapOrderLines(order, productById) {
  const lines = Array.isArray(order.line_items) && order.line_items.length
    ? order.line_items
    : order.product_id
      ? [{ product_id: order.product_id, quantity: 1 }]
      : [];
  return lines
    .map((line) => {
      const pid = line && line.product_id ? String(line.product_id) : "";
      const product = pid ? productById.get(pid) : null;
      const lineSize = line && line.size != null ? String(line.size).trim() : "";
      const lineColor = line && line.color != null ? String(line.color).trim() : "";
      return {
        productId: pid || null,
        quantity: lineQty(line),
        lineSize,
        lineColor,
        title: product ? product.name : String(line && line.name ? line.name : "Unknown product"),
        sourcePlatform: String((product && product.source_platform) || "").toLowerCase(),
        sourceName: String((product && product.source_name) || ""),
        sourceUrl: String((product && product.source_url) || ""),
        sourceProductId: String((product && product.source_product_id) || (product && product.external_id) || ""),
        supplierName: String((product && product.supplier_name) || ""),
      };
    })
    .filter((x) => x.productId || x.sourceProductId || x.sourceUrl);
}

async function loadOrderAndProducts(supabase, orderId) {
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("id,status,customer_email,product_id,line_items,supplier_data,created_at")
    .eq("id", orderId)
    .maybeSingle();
  if (orderErr) throw orderErr;
  if (!order) return { order: null, productById: new Map() };

  const ids = new Set();
  if (order.product_id) ids.add(String(order.product_id));
  if (Array.isArray(order.line_items)) {
    for (const line of order.line_items) {
      if (line && line.product_id) ids.add(String(line.product_id));
    }
  }
  if (!ids.size) return { order, productById: new Map() };

  const { data: products, error: productsErr } = await supabase
    .from("products")
    .select(
      "id,name,color,source_platform,source_name,source_url,source_product_id,external_id,supplier_name,supplier_variants"
    )
    .in("id", Array.from(ids));
  if (productsErr) throw productsErr;
  return {
    order,
    productById: new Map((products || []).map((p) => [String(p.id), p])),
  };
}

async function updateFulfillmentState(supabase, orderId, supplierData, patch) {
  const current = asObj(supplierData);
  const f = asObj(current.fulfillment);
  const next = {
    ...current,
    fulfillment: {
      ...f,
      ...patch,
      updatedAt: new Date().toISOString(),
    },
  };
  const { error } = await supabase.from("orders").update({ supplier_data: next }).eq("id", orderId);
  if (error) throw error;
}

async function processOrderFulfillment(supabase, payload = {}) {
  if (!supabase) return { ok: false, error: "Database not configured" };
  const orderId = String(payload.orderId || "").trim();
  if (!orderId) return { ok: false, error: "Missing orderId" };

  const lockKey = "fulfillment:order:" + orderId;
  const hasLock = await acquireLock(supabase, lockKey, 2 * 60 * 1000);
  if (!hasLock) return { ok: true, skipped: true, reason: "locked_or_processing" };

  try {
    const { order, productById } = await loadOrderAndProducts(supabase, orderId);
    if (!order) return { ok: true, skipped: true, reason: "order_not_found" };
    if (String(order.status || "").toLowerCase() !== "paid") {
      return { ok: true, skipped: true, reason: "order_not_paid" };
    }

    const supplierData = asObj(order.supplier_data);
    const fulfillment = asObj(supplierData.fulfillment);
    if (["submitted", "accepted"].includes(String(fulfillment.status || "").toLowerCase())) {
      return { ok: true, skipped: true, reason: "already_submitted" };
    }

    const lines = mapOrderLines(order, productById);
    if (!lines.length) {
      await updateFulfillmentState(supabase, orderId, supplierData, {
        status: "manual_required",
        reason: "missing_supplier_line_data",
        lastError: "No supplier-mappable line items found",
      });
      return { ok: true, submitted: false, manualRequired: true };
    }

    const groups = new Map();
    for (const line of lines) {
      const platform = String(line.sourcePlatform || "unknown");
      if (!groups.has(platform)) groups.set(platform, []);
      groups.get(platform).push(line);
    }

    const customerPayload = {
      email: order.customer_email || null,
      ...asObj(supplierData.customer),
      shippingCountry: supplierData.shippingCountry || null,
    };

    const runs = [];
    for (const [platform, groupLines] of groups.entries()) {
      const bucket = fulfillmentSupplierBucket(platform);

      if (bucket === "ebay") {
        let insertFailCount = 0;
        let lastInsertError = "";
        for (const line of groupLines) {
          const pid = line.productId ? String(line.productId) : "";
          const product = pid ? productById.get(pid) : null;
          const supplierUrl = String((product && product.source_url) || line.sourceUrl || "");
          const variantData = {
            quantity: line.quantity,
            size: line.lineSize || null,
            color: line.lineColor || (product && product.color) || null,
            title: line.title,
            sourceProductId: line.sourceProductId || null,
            supplier_variants: product && product.supplier_variants != null ? product.supplier_variants : null,
          };
          try {
            await insertEbayFulfillmentQueueIfPending(supabase, {
              order_id: orderId,
              product_id: pid,
              supplier_url: supplierUrl,
              variant_data: variantData,
              customer_data: customerPayload,
            });
          } catch (e) {
            insertFailCount += 1;
            lastInsertError = e && e.message ? e.message : String(e);
            logger.error("fulfillment.ebay_queue.insert_failed", {
              orderId,
              productId: pid,
              error: lastInsertError,
            });
          }
        }
        if (insertFailCount > 0) {
          runs.push({
            platform,
            status: "failed",
            reason: "fulfillment_queue_insert_failed",
            error: lastInsertError || "insert_failed",
            lineCount: insertFailCount,
          });
        }
        if (insertFailCount < groupLines.length) {
          runs.push({
            platform,
            status: "manual_required",
            reason: "fulfillment_inbox",
            lineCount: groupLines.length,
          });
        }
        continue;
      }

      const url = platformWebhookUrl(platform);
      const requestPayload = {
        orderId,
        platform,
        customerEmail: order.customer_email || null,
        customer: asObj(supplierData.customer),
        shippingCountry: supplierData.shippingCountry || null,
        lines: groupLines,
        source: "velden_auto_fulfillment",
        createdAt: new Date().toISOString(),
      };

      if (bucket === "shopify" && !url) {
        runs.push({
          platform,
          status: "manual_required",
          reason: "missing_supplier_webhook_url",
          lineCount: groupLines.length,
        });
        continue;
      }

      if (!url) {
        runs.push({
          platform,
          status: "manual_required",
          reason: "missing_supplier_webhook_url",
          lineCount: groupLines.length,
        });
        continue;
      }

      try {
        const out = await postSupplierOrder(url, requestPayload);
        runs.push({
          platform,
          status: "submitted",
          reference: out.reference || out.id || null,
          lineCount: groupLines.length,
        });
      } catch (e) {
        runs.push({
          platform,
          status: "failed",
          error: e && e.message ? e.message : String(e),
          lineCount: groupLines.length,
        });
      }
    }

    const failed = runs.filter((r) => r.status === "failed").length;
    const submitted = runs.filter((r) => r.status === "submitted").length;
    const manual = runs.filter((r) => r.status === "manual_required").length;
    const status = failed > 0 ? "failed" : manual > 0 ? "manual_required" : submitted > 0 ? "submitted" : "manual_required";

    await updateFulfillmentState(supabase, orderId, supplierData, {
      status,
      runs,
      lastAttemptAt: new Date().toISOString(),
      lastError: failed > 0 ? runs.find((r) => r.status === "failed").error || "submission_failed" : null,
    });

    logger.info("fulfillment.order.processed", {
      orderId,
      status,
      submitted,
      failed,
      manual,
    });
    return { ok: true, status, submitted, failed, manualRequired: manual > 0 };
  } catch (e) {
    logger.error("fulfillment.order.failed", {
      orderId,
      error: e && e.message ? e.message : String(e),
    });
    return { ok: false, error: e && e.message ? e.message : String(e) };
  } finally {
    await releaseLock(supabase, lockKey);
  }
}

module.exports = { processOrderFulfillment };
