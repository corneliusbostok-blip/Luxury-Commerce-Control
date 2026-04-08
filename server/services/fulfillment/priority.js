"use strict";

/**
 * Fulfillment inbox prioritization — sort-only, never filters rows.
 * computeFulfillmentPriority(item, enrichment) uses optional product + order rows from DB.
 */

const EU_ISO2 = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);

/**
 * @param {object} item - fulfillment_queue row (variant_data, customer_data, created_at, …)
 * @param {{ product?: object | null, order?: object | null }} [enrichment]
 * @returns {{ score: number, reasons: string[] }}
 */
function computeFulfillmentPriority(item, enrichment = {}) {
  const reasons = [];
  let score = 0;

  const product = enrichment.product || null;
  const order = enrichment.order || null;
  const vd = item && item.variant_data && typeof item.variant_data === "object" ? item.variant_data : {};
  const cd = item && item.customer_data && typeof item.customer_data === "object" ? item.customer_data : {};
  const qty = Math.max(1, Number(vd.quantity) || 1);

  const price = product != null ? Number(product.price) : 0;
  const cost = product != null ? Number(product.cost) : 0;
  const ship = product != null && product.estimated_shipping_cost != null ? Number(product.estimated_shipping_cost) : 0;
  const ret = product != null && product.return_risk_proxy != null ? Number(product.return_risk_proxy) : 0;

  const hasProductNumbers = product != null && (Number.isFinite(price) || Number.isFinite(cost));
  const unitProfit =
    hasProductNumbers && Number.isFinite(price) && Number.isFinite(cost)
      ? Math.max(0, price - cost - (Number.isFinite(ship) ? ship : 0) - (Number.isFinite(ret) ? ret : 0))
      : 0;

  if (unitProfit > 0) {
    const pts = Math.min(48, unitProfit * 3.2);
    score += pts;
    if (unitProfit >= 28) reasons.push("High unit profit");
    else if (unitProfit >= 14) reasons.push("Solid unit profit");
    else reasons.push("Positive unit profit");
  }

  if (Number.isFinite(price) && price > 0 && Number.isFinite(cost) && cost >= 0) {
    const marginPct = (price - cost) / price;
    if (Number.isFinite(marginPct) && marginPct >= 0) {
      const mPts = Math.min(18, marginPct * 22);
      score += mPts;
      if (marginPct >= 0.48) reasons.push("High margin %");
    }
  }

  const orderCents = order != null ? Number(order.amount_cents) : 0;
  if (Number.isFinite(orderCents) && orderCents > 0) {
    const major = orderCents / 100;
    const oPts = Math.min(14, Math.log10(major + 1) * 8);
    score += oPts;
    if (major >= 220) reasons.push("High order value");
  }

  const createdMs = item && item.created_at ? new Date(item.created_at).getTime() : NaN;
  if (Number.isFinite(createdMs)) {
    const hours = Math.max(0, (Date.now() - createdMs) / 3600000);
    const aPts = Math.min(24, hours * 0.85);
    score += aPts;
    if (hours >= 24) reasons.push("Older order — fulfil soon");
    else if (hours >= 8) reasons.push("Waiting several hours");
  }

  if (product) {
    if (product.available === false) {
      score += 12;
      reasons.push("Stock risk (unavailable flag)");
    }
    const syncErr = String(product.supplier_sync_error || "").trim();
    if (syncErr) {
      score += 6;
      reasons.push("Supplier sync uncertainty");
    }
  }

  const ai = product != null ? Number(product.ai_fit_score) : NaN;
  if (Number.isFinite(ai) && ai > 0) {
    const aiPts = Math.min(12, (ai / 100) * 12);
    score += aiPts;
    if (ai >= 78) reasons.push("Strong AI fit score");
  }

  const shipC = String(cd.shippingCountry || cd.country || "")
    .trim()
    .toUpperCase();
  if (shipC && shipC !== "DK") {
    if (EU_ISO2.has(shipC)) {
      score += 4;
      reasons.push("EU cross-border shipping");
    } else {
      score += 9;
      reasons.push("Non-EU shipping");
    }
  }

  if (qty > 1 && unitProfit > 0) {
    score += Math.min(10, unitProfit * 0.12 * qty);
    reasons.push("Multiple units");
  }

  const rounded = Math.round(score * 10) / 10;
  const uniq = [...new Set(reasons)].slice(0, 6);
  return {
    score: Number.isFinite(rounded) ? rounded : 0,
    reasons: uniq.length ? uniq : ["Limited data — review manually"],
  };
}

/**
 * @param {number} score
 * @returns {{ band: 'high'|'medium'|'low', label: string }}
 */
function priorityBandFromScore(score) {
  const s = Number(score) || 0;
  if (s >= 52) return { band: "high", label: "High Priority" };
  if (s >= 28) return { band: "medium", label: "Medium" };
  return { band: "low", label: "Low" };
}

module.exports = {
  computeFulfillmentPriority,
  priorityBandFromScore,
};
