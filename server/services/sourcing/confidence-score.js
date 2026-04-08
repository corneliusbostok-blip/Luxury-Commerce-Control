function computeConfidenceScore(input = {}) {
  const hasSold = Number.isFinite(Number(input.sold_count));
  const hasReviews = Number.isFinite(Number(input.review_count));
  const hasRating = Number.isFinite(Number(input.rating));
  const available = [hasSold, hasReviews, hasRating].filter(Boolean).length;
  let score = available * 25; // max 75 from completeness

  const ai = Number(input.ai_score);
  const pop = Number(input.popularity_score);
  if (Number.isFinite(ai) && Number.isFinite(pop)) {
    const diff = Math.abs(ai - pop);
    score += Math.max(0, 25 - Math.min(25, diff * 0.5));
  } else if (Number.isFinite(ai) || Number.isFinite(pop)) {
    score += 10;
  }

  score = Math.max(0, Math.min(100, Number(score.toFixed(2))));
  const confidence = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
  return { confidence, confidence_score: score };
}

module.exports = {
  computeConfidenceScore,
};
