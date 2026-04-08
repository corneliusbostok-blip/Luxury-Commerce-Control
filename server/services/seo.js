const { geminiGenerateText, collectGeminiApiKeys } = require("../lib/gemini");
const { stripJsonFence } = require("../lib/ai-json");

function clamp(s, max) {
  const x = String(s || "").trim();
  if (x.length <= max) return x;
  return x.slice(0, max - 1).trim() + "…";
}

function fallbackSeo(product) {
  const name = String(product.name || "Produkt").trim();
  const desc = String(product.description || "").replace(/\s+/g, " ").trim();
  return {
    name,
    description: product.description || desc || `${name} — Velden.`,
    selling_points:
      product.selling_points ||
      "Kvalitetsmaterialer | Tidløst snit | Leveret med omhu",
    seo_meta_title: clamp(name, 60),
    seo_meta_description: clamp(desc || `${name} — Shop hos Velden.`, 155),
  };
}

/**
 * Dansk SEO-tekst til produkt (Gemini). Opdaterer titel, brødtekst, bullets + meta.
 * @param {object} product — række fra products
 */
async function optimizeProductSeoDanish(product) {
  if (!product) return fallbackSeo({});
  if (!collectGeminiApiKeys().length) return fallbackSeo(product);

  try {
    const payload = {
      navn: product.name,
      kategori: product.category,
      nuværende_beskrivelse: String(product.description || "").slice(0, 900),
      salgspunkter: String(product.selling_points || ""),
      ai_note: String(product.brand_fit_reason || "").slice(0, 320),
    };
    const prompt = `Du er SEO-tekstforfatter for den danske herremode-webshop "Velden" (quiet luxury, diskret kvalitet).
Produktdata (JSON): ${JSON.stringify(payload)}

Returner KUN gyldig JSON på dansk:
{
  "name": "kort produkttitel ca. 35–60 tegn, naturligt sprog, ét stærkt søgeord hvor det giver mening",
  "description": "2–4 sætninger butikstekst. Ren tekst eller med simple <p>-tags. Ingen falske certificeringer.",
  "selling_points": "præcis tre meget korte linjer adskilt med tegnet | (pipe med mellemrum omkring)",
  "seo_meta_title": "maks 60 tegn — til Google og browser-fane",
  "seo_meta_description": "maks 155 tegn — snippet med rolig CTA, ikke CLICKBAIT"
}
Krav: hele outputtet skal være på dansk. Ingen engelske fraser undtagen velkendte modeord (fx "Oxford") hvis relevant.`;

    const text = await geminiGenerateText(prompt);
    const j = JSON.parse(stripJsonFence(text));
    return {
      name: clamp(j.name || product.name, 200) || product.name,
      description: String(j.description || product.description || "").trim() || product.description,
      selling_points: String(j.selling_points || product.selling_points || "").trim() || product.selling_points,
      seo_meta_title: clamp(j.seo_meta_title || product.name, 60),
      seo_meta_description: clamp(j.seo_meta_description || product.description, 155),
    };
  } catch (e) {
    console.error("[seo]", e);
    return fallbackSeo(product);
  }
}

module.exports = { optimizeProductSeoDanish, fallbackSeo };
