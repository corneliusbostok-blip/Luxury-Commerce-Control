const { geminiGenerateText, collectGeminiApiKeys } = require("../lib/gemini");
const { stripJsonFence } = require("../lib/ai-json");

async function generateProductCopy(rawTitle, cost, storeConfig) {
  const cfg = storeConfig || {};
  const brand = cfg.brand || "Velden";
  const tone = cfg.tone || "quiet luxury";
  const positioning = cfg.positioning || "timeless menswear";
  if (!collectGeminiApiKeys().length) {
    return {
      brand,
      description: `${rawTitle} — cut for an easy drape and a calm silhouette. Natural fibres where noted; intended for seasons of wear, not seasons of trend.`,
      selling_points: "Understated finish | Considered proportion | Wardrobe permanence",
    };
  }
  try {
    const prompt = `Write luxury ecommerce copy for "${brand}".
Brand tone: ${tone}
Positioning: ${positioning}
Source title: "${rawTitle}". Approximate cost USD ${cost} (internal only; do not mention price).
Return ONLY JSON:
{
  "brand": "${brand}",
  "description": "2-3 sentences on material hand, fit intent, and longevity. No fake certifications.",
  "selling_points": "three restrained phrases separated by | "
}`;
    const text = await geminiGenerateText(prompt);
    const j = JSON.parse(stripJsonFence(text));
    return {
      brand: j.brand || brand,
      description: j.description || "",
      selling_points: j.selling_points || "",
    };
  } catch {
    return {
      brand,
      description: `${rawTitle} — composed tailoring, soft structure, and a palette that lives beyond the season.`,
      selling_points: "Measured ease | Tactile quality | Time over trend",
    };
  }
}

async function generateSocialPack(product, storeConfig) {
  const cfg = storeConfig || {};
  const brand = cfg.brand || product.brand || "Velden";
  const base = {
    tiktok_script: `Hook: "This is the men's piece your feed actually needs." Quick styling clip + detail shot. CTA: Link in bio — ${product.name}.`,
    captions: `${product.name} — Velden.`,
    hashtags: "#quietluxury #oldmoney #mensstyle #velden #classicmenswear",
  };
  if (!collectGeminiApiKeys().length) return base;
  try {
    const prompt = `Product for ${brand}: ${product.name}. Brand line: ${product.brand || brand}. Tone: ${
      cfg.tone || "quiet luxury"
    }.
Return ONLY JSON:
{
  "tiktok_script": "15-25s script: hook, product in context (outfit or use), CTA",
  "captions": "one IG caption line",
  "hashtags": "space-separated hashtags, include mens fashion tags"
}`;
    const text = await geminiGenerateText(prompt);
    const j = JSON.parse(stripJsonFence(text));
    const captionLine = j.captions || j.caption || base.captions;
    return {
      tiktok_script: j.tiktok_script || base.tiktok_script,
      captions: captionLine,
      hashtags: j.hashtags || base.hashtags,
    };
  } catch {
    return base;
  }
}

module.exports = { generateProductCopy, generateSocialPack };
