function clamp01(v) {
  const n = Number(v) || 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function computeConfidence(input) {
  const views = Number(input.views) || 0;
  const clicks = Number(input.clicks) || 0;
  const orders = Number(input.orders) || 0;
  const volume = Math.min(1, views / 200);
  const engagement = Math.min(1, clicks / Math.max(1, views));
  const conversion = Math.min(1, orders / Math.max(1, clicks));
  return clamp01(volume * 0.5 + engagement * 0.25 + conversion * 0.25);
}

function categoryThreshold(categoryId, fallback) {
  const raw = String(process.env.AUTO_APPROVAL_CATEGORY_THRESHOLDS_JSON || "").trim();
  if (!raw) return fallback;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && Number.isFinite(Number(obj[categoryId]))) {
      return Number(obj[categoryId]);
    }
  } catch {
    // ignore malformed env
  }
  return fallback;
}

/**
 * Pseudo:
 * 1) confidence = f(volume, ctr, cvr)
 * 2) threshold = categorySpecificThreshold(category) || defaultThreshold
 * 3) if score >= threshold and confidence >= minConfidence and risk <= maxRisk => auto publish
 * 4) else => manual review queue
 */
function decideAutoApproval(input) {
  const score = Number(input.score) || 0;
  const riskScore = Number(input.riskScore) || 0;
  const categoryId = String(input.categoryId || "other");
  const thresholdBase = Number(input.threshold) || 80;
  const threshold = categoryThreshold(categoryId, thresholdBase);
  const riskMax = Number(input.riskMax) || 20;
  const minConfidence = Number(input.minConfidence) || 0.35;
  const confidence = Number.isFinite(Number(input.confidence))
    ? clamp01(input.confidence)
    : computeConfidence(input);

  if (score >= threshold && riskScore <= riskMax && confidence >= minConfidence) {
    return {
      decision: "AUTO_PUBLISHED",
      publish: true,
      queueAdmin: false,
      confidence,
      threshold,
    };
  }
  return {
    decision: "ADMIN_REVIEW",
    publish: false,
    queueAdmin: true,
    confidence,
    threshold,
  };
}

module.exports = { decideAutoApproval, computeConfidence };
