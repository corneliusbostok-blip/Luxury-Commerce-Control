function asNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function inferAgeDays(input = {}) {
  const listedAtRaw = input.listing_date || input.listed_at || input.item_start_date || null;
  if (listedAtRaw) {
    const ts = new Date(listedAtRaw).getTime();
    if (Number.isFinite(ts) && ts > 0) {
      return Math.max(0, Math.floor((Date.now() - ts) / 86400000));
    }
  }
  const sold = asNumberOrNull(input.sold_count);
  const reviews = asNumberOrNull(input.review_count);
  if (sold == null || reviews == null) return null;
  const ratio = sold / Math.max(1, reviews);
  if (ratio > 25 && sold > 100) return 210;
  if (ratio > 12 && sold > 60) return 120;
  if (ratio < 4) return 35;
  return 90;
}

function computePopularityScore(input = {}) {
  const sold = asNumberOrNull(input.sold_count);
  const reviews = asNumberOrNull(input.review_count);
  const rating = asNumberOrNull(input.rating);
  const ageDays = inferAgeDays(input);

  const soldNorm = sold == null ? null : Math.min(100, (sold / 100) * 100);
  const reviewNorm = reviews == null ? null : Math.min(100, (reviews / 50) * 100);
  const ratingNorm = rating == null ? null : Math.min(100, Math.max(0, (rating / 5) * 100));

  const parts = [soldNorm, reviewNorm, ratingNorm].filter((x) => x != null);
  if (!parts.length) {
    return { score: null, level: "unknown", recency_level: "unknown", age_days: ageDays };
  }

  let score = Number((parts.reduce((a, b) => a + b, 0) / parts.length).toFixed(2));
  let recencyLevel = "unknown";
  if (ageDays != null) {
    if (ageDays > 180) {
      score *= 0.7;
      recencyLevel = "old";
    } else if (ageDays < 30) {
      score *= 1.2;
      recencyLevel = "new";
    } else {
      recencyLevel = "mid";
    }
  }
  score = Number(Math.max(0, Math.min(100, score)).toFixed(2));
  const level = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
  return { score, level, recency_level: recencyLevel, age_days: ageDays };
}

module.exports = {
  computePopularityScore,
};
