/**
 * Velden product-sourcing AI: brand-fit gate + structured JSON for DB + dashboard.
 * Gemini when configured; else deterministic heuristic aligned with Velden rules.
 */
const { inferCategory, normalizeCategoryId, VALID_CATEGORY_IDS } = require("./category");
const { normalizeImages, normalizeVariants, hasAvailableVariant } = require("./product-sync-normalizer");
const { stripJsonFence } = require("../lib/ai-json");
const { geminiGenerateText, collectGeminiApiKeys } = require("../lib/gemini");
const { STORE_VERTICALS, LABELS_DA, inferStoreVerticalKey } = require("./store-taxonomy");

const ALLOWED_CATEGORIES = new Set(VALID_CATEGORY_IDS);

const HOME_CATEGORY_IDS = new Set(
  (STORE_VERTICALS.find((v) => v.key === "home") || { categoryIds: [] }).categoryIds
);

const WOMENS_TITLE_PATTERNS = [
  /women'?s?\b/i,
  /\bladies\b/i,
  /\bwomens\b/i,
];

const KIDS_TITLE_PATTERNS = [
  /\bkids?\b/i,
  /\bchild\b/i,
  /\bboys?\b/i,
  /\bgirls?\b/i,
  /\btoddler\b/i,
];

const STREET_HYPE_PATTERNS = [/\byeezy\b/i, /\bhypebeast\b/i, /\bstreetwear\b/i, /\bgraphic\s+tee\b/i, /neon/i];

const FEMME_SILHOUETTE_PATTERNS = [/\bcrop\s+top\b/i, /\bmini\s+dress\b/i, /\bheel\b/i, /\bstiletto\b/i];

const ATHLETIC_FOOTWEAR_PATTERNS = [/\bsneaker/i, /\bathletic\b/i, /\brunning\s+shoe/i, /\bslide\s+sandal/i];

const FURNITURE_HOME_PATTERNS = [
  /\b(rocking|dining|office|lounge|folding|accent|arm|deck|beach|gaming)\s*chair(s)?\b/i,
  /\bchair(s)?\b/i,
  /\bbar\s*stool(s)?\b/i,
  /\bstool(s)?\b/i,
  /\bsofa\b/i,
  /\bcouch\b/i,
  /\bsectional\b/i,
  /\bloveseat\b/i,
  /\botto(man|men)\b/i,
  /\b(coffee|dining|side|console|night)\s*table(s)?\b/i,
  /\btable\s+lamp\b/i,
  /\bdesk(s)?\b/i,
  /\bwardrobe(s)?\b/i,
  /\bdresser(s)?\b/i,
  /\bbookshelf\b/i,
  /\bbookcase(s)?\b/i,
  /\bnightstand(s)?\b/i,
  /\bheadboard(s)?\b/i,
  /\bmattress(es)?\b/i,
  /\bfurniture\b/i,
  /\bfurnishing(s)?\b/i,
  /\bhome\s+decor\b/i,
  /\binterior\s+design\b/i,
];

const WHOLESALE_MIX_PATTERNS = [
  /\b25\s*kg\b/i,
  /\b\d{1,2}\s*kg\s+(branded|mix|second|hand|vintage|wholesale|bale|lot)\b/i,
  /\bkg\s+branded\b/i,
  /\bkg\s+mix\b/i,
  /\bkg\s+second\b/i,
  /\bsecond\s+hand\s+mix\b/i,
  /\bwholesale\s+(lot|mix|bale|bundle|pack)\b/i,
  /\bvintage\s+(lot|wholesale|bale)\b/i,
  /\bbulk\s+(mix|clothing|apparel|lot)\b/i,
  /\bbranded\s+mix\b/i,
  /\bgrade\s*[abc]\b.*\b(kg|mix|bale|lot)\b/i,
  /\bjob\s*lot\b/i,
  /\bpallet\s*(of|load)\b/i,
  /\bmystery\s+box\b.*\b(kg|clothing|apparel)\b/i,
];

/**
 * Titelfiltre der før var låst til «Velden herremode» — nu afhængige af butikstype + valgte kategorier.
 * @param {object | null | undefined} storeConfig
 * @returns {RegExp[]}
 */
function activeRejectPatterns(storeConfig) {
  const cfg = storeConfig || {};
  const cats = Array.isArray(cfg.allowedCategories)
    ? cfg.allowedCategories.map((x) => normalizeCategoryId(x)).filter(Boolean)
    : [];
  const vkRaw = String(cfg.adminVerticalKey || "").trim();
  const vk = vkRaw || inferStoreVerticalKey(cats);

  const hasWomensCat = cats.some((c) => /^womens_/i.test(c));
  const hasKidsFamilyCat = cats.some((c) => /^kids_/i.test(c) || /^baby_/i.test(c));

  const touchesHome = vk === "home" || cats.some((c) => HOME_CATEGORY_IDS.has(c));

  const allowsSneakerish =
    cats.includes("shoes") ||
    cats.includes("footwear_sneakers") ||
    cats.includes("footwear_sports") ||
    cats.includes("footwear_boots") ||
    cats.includes("footwear_sandals");

  const athleticVertical = vk === "sports" || vk === "footwear";

  const out = [...WHOLESALE_MIX_PATTERNS];

  if (!touchesHome) out.push(...FURNITURE_HOME_PATTERNS);
  if (!hasWomensCat) out.push(...WOMENS_TITLE_PATTERNS);
  if (!hasKidsFamilyCat && !["baby", "toys"].includes(vk)) out.push(...KIDS_TITLE_PATTERNS);
  if (!allowsSneakerish && !athleticVertical) out.push(...ATHLETIC_FOOTWEAR_PATTERNS);

  if (vk === "fashion" || vk === "jewelry_watches") {
    out.push(...STREET_HYPE_PATTERNS);
    if (!hasWomensCat) out.push(...FEMME_SILHOUETTE_PATTERNS);
  }

  return out;
}

const POSITIVE_SIGNALS = [
  /merino/i,
  /cashmere/i,
  /linen/i,
  /wool/i,
  /cotton/i,
  /silk/i,
  /leather/i,
  /suede/i,
  /tailored/i,
  /slim\s+fit/i,
  /classic/i,
  /minimal/i,
  /dress\s+shirt/i,
  /oxford/i,
  /loafer/i,
  /chino/i,
  /overcoat/i,
  /blazer/i,
];

function clampScore(n) {
  const x = Math.round(Number(n));
  if (Number.isNaN(x)) return 0;
  return Math.min(100, Math.max(0, x));
}

function sourceQualityScore(candidate, sourceMeta) {
  const title = String(candidate.title || "");
  const hasImage = Boolean(String(candidate.image || "").trim());
  const hasUrl = Boolean(String(sourceMeta.sourceUrl || "").trim());
  const supplierCountry = String(sourceMeta.supplierCountry || "").toUpperCase();
  const price = Number(candidate.price) || 0;
  let reliability = 35;
  if (hasUrl) reliability += 20;
  if (supplierCountry === "DK" || supplierCountry === "DE" || supplierCountry === "NL") reliability += 10;
  const priceAdvantage = price > 0 && price < 1200 ? 20 : price > 0 && price < 1800 ? 12 : 5;
  const completeness = (title ? 8 : 0) + (hasImage ? 12 : 0) + (hasUrl ? 10 : 0);
  return {
    total: Math.max(0, Math.min(100, reliability + priceAdvantage + completeness)),
    reliability: Math.max(0, Math.min(100, reliability)),
    priceAdvantage,
    completeness,
  };
}

function heuristicEvaluate(candidate, sourceMeta, options = {}) {
  const cfg = options.storeConfig || {};
  const sq = sourceQualityScore(candidate, sourceMeta);
  const title = String(candidate.title || "").slice(0, 300);
  const price = Number(candidate.price) || 0;
  const image = String(candidate.image || "").trim();
  const cat = normalizeCategoryId(inferCategory(title, candidate.category));
  const sourceUrl = String(sourceMeta.sourceUrl || "").trim();

  let aiScore = 55;
  let status = "draft";
  let brandFitReason =
    "Heuristic review: neutral assessment pending full AI or manual approval.";

  const allowedCategories = Array.isArray(cfg.allowedCategories) ? cfg.allowedCategories : [];
  const blockedKeywords = Array.isArray(cfg.blockedKeywords) ? cfg.blockedKeywords : [];
  const minPrice = Number(cfg.priceRange && cfg.priceRange.min);
  const maxPrice = Number(cfg.priceRange && cfg.priceRange.max);

  if (!title || price <= 0 || !image) {
    return {
      title,
      price,
      description: "",
      image,
      category: cat,
      sourcePlatform: sourceMeta.sourcePlatform || "",
      sourceName: sourceMeta.sourceName || "",
      sourceUrl,
      sourceProductId: String(sourceMeta.sourceProductId || candidate.externalId || ""),
      supplierName: sourceMeta.supplierName || "",
      supplierCountry: sourceMeta.supplierCountry || "",
      importMethod: sourceMeta.importMethod || "",
      aiScore: 0,
      brandFitReason: "Missing title, price, or image — cannot list.",
      status: "rejected",
    };
  }

  if (activeRejectPatterns(cfg).some((re) => re.test(title))) {
    return {
      title,
      price,
      description: "",
      image,
      category: cat,
      sourcePlatform: sourceMeta.sourcePlatform || "",
      sourceName: sourceMeta.sourceName || "",
      sourceUrl,
      sourceProductId: String(sourceMeta.sourceProductId || candidate.externalId || ""),
      supplierName: sourceMeta.supplierName || "",
      supplierCountry: sourceMeta.supplierCountry || "",
      importMethod: sourceMeta.importMethod || "",
      aiScore: 5,
      brandFitReason:
        "Titlen matcher butikkens afvisningsmønstre (kategori/vertikal): fx forkert kørn/alder, bolig/møbler, engros-mix eller andre off-brief signaler.",
      status: "rejected",
    };
  }

  if (allowedCategories.length && !allowedCategories.includes(cat)) {
    return {
      title,
      price,
      description: "",
      image,
      category: cat,
      sourcePlatform: sourceMeta.sourcePlatform || "",
      sourceName: sourceMeta.sourceName || "",
      sourceUrl,
      sourceProductId: String(sourceMeta.sourceProductId || candidate.externalId || ""),
      supplierName: sourceMeta.supplierName || "",
      supplierCountry: sourceMeta.supplierCountry || "",
      importMethod: sourceMeta.importMethod || "",
      aiScore: 10,
      brandFitReason: "Category is disabled by store config.",
      status: "rejected",
    };
  }
  if (blockedKeywords.some((kw) => kw && title.toLowerCase().includes(String(kw).toLowerCase()))) {
    return {
      title,
      price,
      description: "",
      image,
      category: cat,
      sourcePlatform: sourceMeta.sourcePlatform || "",
      sourceName: sourceMeta.sourceName || "",
      sourceUrl,
      sourceProductId: String(sourceMeta.sourceProductId || candidate.externalId || ""),
      supplierName: sourceMeta.supplierName || "",
      supplierCountry: sourceMeta.supplierCountry || "",
      importMethod: sourceMeta.importMethod || "",
      aiScore: 5,
      brandFitReason: "Blocked by configured keyword policy.",
      status: "rejected",
    };
  }
  if ((Number.isFinite(minPrice) && price < minPrice) || (Number.isFinite(maxPrice) && maxPrice > 0 && price > maxPrice)) {
    return {
      title,
      price,
      description: "",
      image,
      category: cat,
      sourcePlatform: sourceMeta.sourcePlatform || "",
      sourceName: sourceMeta.sourceName || "",
      sourceUrl,
      sourceProductId: String(sourceMeta.sourceProductId || candidate.externalId || ""),
      supplierName: sourceMeta.supplierName || "",
      supplierCountry: sourceMeta.supplierCountry || "",
      importMethod: sourceMeta.importMethod || "",
      aiScore: 20,
      brandFitReason: "Outside configured source price range.",
      status: "rejected",
    };
  }

  const brandShort = String(cfg.brand || "Butik").trim() || "Butik";
  if (!sourceUrl) {
    aiScore = 42;
    status = "draft";
    brandFitReason = `Ingen direkte kilde-URL — beholdt som kladde (${brandShort} sourcing-regler).`;
  } else {
    aiScore += POSITIVE_SIGNALS.some((re) => re.test(title)) ? 22 : 8;
    aiScore += Math.round((sq.total - 50) * 0.16);
    if (cat !== "other") aiScore += 12;
    aiScore = clampScore(aiScore);
    if (aiScore >= 78) {
      status = "approved";
      brandFitReason =
        "Heuristik: stærk titel-/kategori-match, rimelig kildekvalitet og sporbar URL.";
    } else if (aiScore >= 50) {
      status = "draft";
      brandFitReason = "Heuristik: plausibel match, men ikke stærk nok til automatisk godkendelse.";
    } else {
      status = "rejected";
      brandFitReason = "Heuristik: svag match ift. butikkens profil eller uklar kategori.";
    }
  }

  return {
    title,
    price,
    description: "",
    image,
    category: cat,
    sourcePlatform: sourceMeta.sourcePlatform || "",
    sourceName: sourceMeta.sourceName || "",
    sourceUrl,
    sourceProductId: String(sourceMeta.sourceProductId || candidate.externalId || ""),
    supplierName: sourceMeta.supplierName || "",
    supplierCountry: sourceMeta.supplierCountry || "",
    importMethod: sourceMeta.importMethod || "",
    aiScore: clampScore(aiScore),
    brandFitReason,
    sourceQuality: sq,
    status,
  };
}

function buildMerchandisingRulesFragment(storeConfig) {
  const m =
    storeConfig &&
    storeConfig.sourcing &&
    storeConfig.sourcing.merchandising &&
    typeof storeConfig.sourcing.merchandising === "object"
      ? storeConfig.sourcing.merchandising
      : {};
  const focus = String(m.focus || "balanced").toLowerCase();
  const season = String(m.seasonNote || "").trim();
  const vibe = String(m.vibeKeywords || "").trim();
  const bits = [];
  if (focus === "trending") {
    bits.push(
      "Prioritér **aktuelle, hypede eller tydeligt trending** varer (SoMe-stemning, limited drops, viral estetik) når de stadig passer vertikal og kategorier — giv højere aiScore når det giver mening; afvis hvis det er useriøst eller off-brief.",
    );
  } else if (focus === "seasonal") {
    bits.push(
      season
        ? `Butikken har valgt **sæson/kollektion**: «${season.slice(0, 120)}». Foretræk kandidater der tydeligt matcher (materiale, farve, titel/beskrivelse).`
        : "Butikken er **sæsonbetonet**: foretræk varer der tydeligt passer en aktuel sæson eller kollektion når det fremgår af produktet.",
    );
  } else if (focus === "timeless") {
    bits.push(
      "Prioritér **tidløs kvalitet** og klassiske silhuetter; vær skeptisk over for ren gimmick-trend der ikke holder til butikkens profil.",
    );
  } else {
    bits.push("Sortimentsprioritet er **balanceret** — hverken ekstrem trend-jagt eller kun klassikere.");
  }
  if (vibe) {
    bits.push(
      `Butikkens **ekstra ledetråde** (vejledende stemningsord — ikke obligatorisk ordret match i titel): ${vibe.slice(0, 400)}.`,
    );
  }
  if (!bits.length) return "";
  return `\n**Sortimentsfokus (indstillinger):**\n${bits.map((b) => `- ${b}`).join("\n")}\n`;
}

function coerceEval(json, candidate, sourceMeta, options = {}) {
  const base = heuristicEvaluate(candidate, sourceMeta, options);
  if (!json || typeof json !== "object") return base;

  const title = String(json.title || candidate.title || "").slice(0, 300);
  const price = Number(json.price) > 0 ? Number(json.price) : Number(candidate.price) || 0;
  const image = String(json.image || candidate.image || "").trim();
  let category = normalizeCategoryId(json.category || candidate.category);
  if (!ALLOWED_CATEGORIES.has(category)) category = base.category;

  const sourcePlatform = String(json.sourcePlatform || sourceMeta.sourcePlatform || "").slice(0, 120);
  const sourceName = String(json.sourceName || sourceMeta.sourceName || "").slice(0, 200);
  const sourceUrl = String(json.sourceUrl || sourceMeta.sourceUrl || "").trim();
  const sourceProductId = String(
    json.sourceProductId || sourceMeta.sourceProductId || candidate.externalId || ""
  ).slice(0, 200);
  const supplierName = String(json.supplierName || sourceMeta.supplierName || "").slice(0, 200);
  const supplierCountry = String(json.supplierCountry || sourceMeta.supplierCountry || "").slice(0, 80);
  const importMethod = String(json.importMethod || sourceMeta.importMethod || "").slice(0, 40);
  const aiScore = clampScore(json.aiScore != null ? json.aiScore : base.aiScore);
  const brandFitReason = String(json.brandFitReason || base.brandFitReason).slice(0, 2000);
  let status = String(json.status || base.status).toLowerCase();
  if (!["draft", "approved", "rejected"].includes(status)) status = base.status;

  if (!sourceUrl || !sourcePlatform) {
    status = status === "approved" ? "draft" : status;
  }

  if (status === "approved" && aiScore < 75) {
    status = "draft";
  }

  const description = String(json.description || "").trim().slice(0, 8000);

  return {
    title,
    price,
    description,
    image,
    category,
    sourcePlatform,
    sourceName,
    sourceUrl,
    sourceProductId,
    supplierName,
    supplierCountry,
    importMethod,
    aiScore,
    brandFitReason,
    sourceQuality: base.sourceQuality,
    status,
  };
}

/**
 * Når brugeren har valgt kategorier i dashboard, skal sourcing-chat ikke afvise fx legetøj/maling
 * alene fordi brand-navnet lyder «luksus» (Gemini/heuristik ellers strammer).
 */
function applySourcingChatExplicitCategoryApproval(result, candidate, sourceMeta, options = {}) {
  if (!options.sourcingChatMode || !result || typeof result !== "object") return result;
  const cfg = options.storeConfig || {};
  const allowed = new Set(
    Array.isArray(cfg.allowedCategories)
      ? cfg.allowedCategories.map((x) => normalizeCategoryId(x)).filter(Boolean)
      : []
  );
  if (!allowed.size) return result;
  const title = String(candidate.title || result.title || "");
  let cat = normalizeCategoryId(result.category);
  if (!cat || cat === "other") {
    cat = normalizeCategoryId(inferCategory(title, candidate.category));
  }
  if (!cat || cat === "other" || !allowed.has(cat)) return result;

  if (activeRejectPatterns(cfg).some((re) => re.test(title))) return result;

  const reason = String(result.brandFitReason || "");
  if (
    /Missing title|price, or image|Manglende titel|afvisningsmønstre|Category is disabled|Blocked by configured|Outside configured source price|Cannot list/i.test(
      reason
    )
  ) {
    return result;
  }

  const sourceUrl = String(result.sourceUrl || sourceMeta.sourceUrl || "").trim();
  const image = String(result.image || candidate.image || "").trim();
  const price = Number(result.price != null ? result.price : candidate.price) || 0;
  if (!sourceUrl || !image || price <= 0) return result;

  const aiScore = Math.max(clampScore(result.aiScore), 78);
  return {
    ...result,
    category: cat,
    status: "approved",
    aiScore,
    brandFitReason:
      "Tilladt kategori under Indstillinger + sporbar kilde (URL, pris, billede). Godkendt i sourcing-chat.",
  };
}

function buildSourcingSystemRules(storeConfig, evalOptions = {}) {
  const cfg = storeConfig || {};
  const brand = String(cfg.brand || "Butik").trim() || "Butik";
  const cats = Array.isArray(cfg.allowedCategories)
    ? cfg.allowedCategories.map((x) => normalizeCategoryId(x)).filter(Boolean)
    : [];
  const vk = String(cfg.adminVerticalKey || "").trim() || inferStoreVerticalKey(cats);
  const vert = STORE_VERTICALS.find((v) => v.key === vk);
  const vertLabel = vert ? vert.label : vk;
  const tone = String(cfg.tone || "").trim();
  const positioning = String(cfg.positioning || "").trim();
  const blocked = Array.isArray(cfg.blockedKeywords) ? cfg.blockedKeywords.filter(Boolean) : [];
  const catBlock =
    cats.length > 0
      ? cats
          .map((id) => `- ${id}${LABELS_DA[id] ? ` (${LABELS_DA[id]})` : ""}`)
          .join("\n")
      : "- (ingen begrænsning i config — vælg en passende kategori fra taxonomy)";

  const chatModeNote =
    evalOptions.sourcingChatMode && cats.length > 0
      ? `\n**Sourcing-chat (aktiv):** Butikken har allerede defineret **tilladte kategorier** (listen ovenfor). Et produkt der tydeligt hører til én af disse kategorier og har gyldig kilde-URL, pris og produktbillede skal have status **approved** med aiScore mindst **75**, medmindre titlen tydeligt er engros/bulk/spam eller bryder blokeringerne ovenfor. Ignorér at brand-navnet kan lyde som herremode/luksus — sortimentet styres af kategori-listen.\n`
      : "";

  const homeNote =
    vk === "home" || cats.some((c) => HOME_CATEGORY_IDS.has(c))
      ? "Bolig/møbler/interiør er **tilladt** for denne butikstype."
      : "Afvis møbler, boliginteriør og «home decor» hvis produktet tydeligt er det.";

  const genderNote = cats.some((c) => /^womens_/i.test(c))
    ? "Damevarer kan være relevante."
    : "Afvis tydelige damevarer medmindre titlen er unisex/neutral og passer til sortimentet.";
  const kidsNote =
    cats.some((c) => /^kids_/i.test(c) || /^baby_/i.test(c)) || ["baby", "toys"].includes(vk)
      ? "Børne-/baby-relaterede produkter kan være relevante."
      : "Afvis tydelige børnevarer hvis butikken ikke målretter børn.";

  const merchFrag = buildMerchandisingRulesFragment(cfg);

  return `Du er produktindkøbs-AI for **${brand}**.

Butikstype (vertikal): **${vertLabel}** (${vk}).
${tone ? `Tone: ${tone}.` : ""} ${positioning ? `Positionering: ${positioning}.` : ""}
${merchFrag}
Din opgave er at vurdere ét kandidatprodukt og returnere struktureret JSON. Følg butikkens vertikal og **kun** de kategorier kunden har slået til (se nedenfor).
${chatModeNote}
**Tilladte kategorier** (vælg præcis én der matcher produktet; skal være blandt disse når listen er ikke-tom):
${catBlock}

${homeNote}
${genderNote}
${kidsNote}
- Enkeltstykker til detail — afvis **engros/bulk** (kg-mix, vintagesække, job lots, mystery pallets med tøj) medmindre butikken tydeligt er B2B.
- ${blocked.length ? `Afvis hvis titlen indeholder: ${blocked.join(", ")}.` : "Respekter eventuelle blocked keywords i payload under storeConfig."}

Data der SKAL udfyldes (brug kildedata hvor muligt):
- title, price (tal), description (2–4 sætninger i ${brand}s tone), image (URL),
- category (slug som i listen ovenfor),
- sourcePlatform, sourceName, sourceUrl, sourceProductId, supplierName, supplierCountry, importMethod,
- aiScore 0–100 (match til butikken),
- brandFitReason (kort),
- status: "draft" | "approved" | "rejected"

Kun stærke matches: status "approved" (typisk aiScore ≥ 75–80 og tydelig kilde-URL).
Manglende kilde-URL eller tvivl → "draft". Alt der bryder reglerne → "rejected".

Returnér KUN gyldig JSON, ingen markdown.`;
}

function titleFailsVeldenBrief(title, storeConfig = null) {
  const t = String(title || "");
  return activeRejectPatterns(storeConfig).some((re) => re.test(t));
}

async function evaluateVeldenSourcing(candidate, sourceMeta, options = {}) {
  const cfg = options.storeConfig || {};
  const fallback = heuristicEvaluate(candidate, sourceMeta, options);
  const finalize = (inner) => {
    const applied = applySourcingChatExplicitCategoryApproval(inner, candidate, sourceMeta, options);
    const images = normalizeImages(candidate.images || applied.images || [applied.image || candidate.image], applied.image || candidate.image || "");
    const variants = normalizeVariants(candidate.variants || applied.variants, {
      size: "unknown",
      color: candidate.color || null,
      price: Number(applied.price || candidate.price) || 0,
      available: candidate.available !== false,
    });
    return {
      ...applied,
      image: images[0] || applied.image || "",
      images,
      variants,
      available: hasAvailableVariant(variants),
      sourceQuery: String(candidate.sourceQuery || "").trim(),
      discovery_selection_mode: String(candidate.discovery_selection_mode || "exploit"),
      discovery_query_confidence: String(candidate.discovery_query_confidence || "low"),
    };
  };
  if (!collectGeminiApiKeys().length) return finalize(fallback);

  const payload = {
    candidate: {
      title: candidate.title,
      price: candidate.price,
      image: candidate.image,
      category: candidate.category,
      color: candidate.color,
      externalId: candidate.externalId,
    },
    sourceMeta,
    storeConfig: {
      brand: cfg.brand,
      adminVerticalKey: cfg.adminVerticalKey || "",
      tone: cfg.tone || "",
      positioning: cfg.positioning || "",
      allowedCategories: cfg.allowedCategories || [],
      blockedKeywords: cfg.blockedKeywords || [],
      priceRange: cfg.priceRange || null,
      strategy: cfg.strategy || null,
      sourcingChatMode: Boolean(options.sourcingChatMode),
      merchandising:
        cfg.sourcing && cfg.sourcing.merchandising && typeof cfg.sourcing.merchandising === "object"
          ? cfg.sourcing.merchandising
          : { focus: "balanced", seasonNote: "", vibeKeywords: "" },
    },
  };

  const prompt = `${buildSourcingSystemRules(cfg, options)}

Kandidat + kildemetadata (JSON):
${JSON.stringify(payload, null, 2)}

Svar med præcis ét JSON-objekt med nøglerne:
title, price, description, image, category, sourcePlatform, sourceName, sourceUrl, sourceProductId, supplierName, supplierCountry, importMethod, aiScore, brandFitReason, status`;

  try {
    const text = await geminiGenerateText(prompt);
    const json = JSON.parse(stripJsonFence(text));
    return finalize(coerceEval(json, candidate, sourceMeta, options));
  } catch (e) {
    console.warn("[sourcing] Gemini failed, using heuristic:", e.message);
    return finalize(fallback);
  }
}

module.exports = {
  evaluateVeldenSourcing,
  heuristicEvaluate,
  titleFailsVeldenBrief,
  activeRejectPatterns,
  buildSourcingSystemRules,
};
