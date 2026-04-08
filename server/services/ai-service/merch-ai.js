const { optimizeProductSeoDanish } = require("../seo");

function estimateRiskScore(candidate) {
  const missingUrl = !String(candidate.source_url || candidate.sourceUrl || "").trim();
  const missingImage = !String(candidate.image_url || candidate.image || "").trim();
  const aiFit = Number(candidate.ai_fit_score || candidate.aiScore) || 0;
  const riskLevel = String(candidate.risk_level || candidate.riskLevel || "balanced").toLowerCase();
  const supplier = String(candidate.supplier_name || candidate.supplierName || "").trim();
  const unknownBrand = supplier.length < 2 || /unknown|n\/a|na|generic/i.test(supplier);
  let risk = 10;
  if (missingUrl) risk += 45;
  if (missingImage) risk += 25;
  if (aiFit < 60) risk += 20;
  if (riskLevel === "low" && unknownBrand) risk += 25;
  if (riskLevel === "high") risk -= 10;
  return Math.min(100, risk);
}

function suggestPrice(input) {
  const cost = Number(input.cost) || 0;
  const ctr = Number(input.ctr) || 0;
  const cvr = Number(input.cvr) || 0;
  const goal = String(input.goal || "profit").toLowerCase();
  const marginTarget = goal === "growth" ? 1.75 : goal === "balanced" ? 2.0 : 2.3;
  const perfFactor = goal === "growth" ? (ctr > 0.06 ? 0.96 : 1) : cvr > 0.08 ? 1.08 : ctr < 0.03 ? 0.95 : 1;
  return Math.max(29, Number((cost * marginTarget * perfFactor).toFixed(2)));
}

function computeMerchScore(input) {
  const goal = String(input.goal || "profit").toLowerCase();
  const riskLevel = String(input.riskLevel || input.risk_level || "balanced").toLowerCase();
  const marginPct = Number(input.marginPct) || 0;
  const ctr = Number(input.ctr) || 0;
  const trendScore = Number(input.trendScore) || 0;
  const aiFit = Number(input.aiFit || input.ai_fit_score) || 0;
  const supplier = String(input.supplierName || input.supplier_name || "").trim();
  const unknownBrand = supplier.length < 2 || /unknown|n\/a|na|generic/i.test(supplier);

  let score = 0;
  if (goal === "growth") score = trendScore * 0.45 + ctr * 200 * 0.35 + aiFit * 0.2;
  else if (goal === "balanced") score = marginPct * 100 * 0.4 + ctr * 200 * 0.3 + trendScore * 0.15 + aiFit * 0.15;
  else score = marginPct * 100 * 0.55 + aiFit * 0.25 + ctr * 200 * 0.2;

  if (riskLevel === "low" && unknownBrand) score -= 25;
  if (riskLevel === "high" && trendScore > 60) score += 10;

  return Math.max(0, Math.min(100, Number(score.toFixed(2))));
}

function combineAiWithPopularity(aiScore, popularityScore) {
  const ai = Number(aiScore);
  const pop = Number(popularityScore);
  if (!Number.isFinite(pop)) return Number.isFinite(ai) ? ai : 0;
  const out = 0.6 * (Number.isFinite(ai) ? ai : 0) + 0.4 * pop;
  return Math.max(0, Math.min(100, Number(out.toFixed(2))));
}

function evaluatePriceSanity(input = {}) {
  const price = Number(input.price);
  const categoryAvgPrice = Number(input.categoryAvgPrice);
  const category = String(input.category || "other").toLowerCase();
  let penalty = 0;
  let price_flag = "ok";

  const hardLow = 3;
  const hardHigh = 1000;
  if (Number.isFinite(price) && (price < hardLow || price > hardHigh)) {
    penalty += 15;
    price_flag = price < hardLow ? "suspicious_low" : "suspicious_high";
  }
  const categoryBands = {
    watches: { low: 25, high: 2500 },
    outerwear: { low: 15, high: 1500 },
    shoes: { low: 10, high: 1200 },
    accessories: { low: 5, high: 800 },
  };
  const b = categoryBands[category] || { low: 3, high: 1000 };
  if (Number.isFinite(price) && (price < b.low || price > b.high)) {
    penalty += 8;
    if (price_flag === "ok") price_flag = price < b.low ? "suspicious_low" : "suspicious_high";
  }
  if (Number.isFinite(price) && Number.isFinite(categoryAvgPrice) && categoryAvgPrice > 0) {
    if (price < categoryAvgPrice * 0.4) {
      penalty += 10;
      if (price_flag === "ok") price_flag = "suspicious_low";
    } else if (price > categoryAvgPrice * 2.4) {
      penalty += 10;
      if (price_flag === "ok") price_flag = "suspicious_high";
    }
  }

  return { penalty: Math.min(40, penalty), price_flag };
}

async function enrichSeoForSourcing(candidate) {
  const seo = await optimizeProductSeoDanish(candidate);
  return {
    ...candidate,
    name: seo.name || candidate.name,
    description: seo.description || candidate.description,
    selling_points: seo.selling_points || candidate.selling_points,
    seo_meta_title: seo.seo_meta_title || candidate.seo_meta_title || "",
    seo_meta_description: seo.seo_meta_description || candidate.seo_meta_description || "",
  };
}

module.exports = {
  estimateRiskScore,
  suggestPrice,
  computeMerchScore,
  combineAiWithPopularity,
  evaluatePriceSanity,
  enrichSeoForSourcing,
};
