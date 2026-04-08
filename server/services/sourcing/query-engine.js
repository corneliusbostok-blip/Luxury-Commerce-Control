"use strict";

const { normalizeCategoryId } = require("../category");
const { STORE_VERTICALS, LABELS_DA } = require("../store-taxonomy");
const { buildTrendSignals } = require("../trends/trend-engine");
const { getLearningMemory } = require("../learning/memory");

const WORD_STOP = new Set([
  "find",
  "vis",
  "mig",
  "giv",
  "vil",
  "have",
  "jeg",
  "det",
  "den",
  "som",
  "med",
  "til",
  "fra",
  "bare",
  "ogsa",
  "ogsaa",
  "lige",
  "noget",
  "please",
  "show",
  "get",
  "the",
  "for",
  "og",
  "en",
  "et",
  "a",
  "an",
  "i",
  "pa",
]);

const CATEGORY_KEYWORDS = [
  { id: "shoes", re: /\b(sko|shoes?|boots?|loafers?|derby|oxford|sneakers?)\b/gi },
  { id: "footwear_boots", re: /\b(boots?|stovler?|ankle\s+boot|chelsea)\b/gi },
  { id: "footwear_sneakers", re: /\b(sneakers?|trainers?)\b/gi },
  { id: "shirts", re: /\b(skjorte|skjorter|shirts?|oxford|poplin|button[-\s]?down)\b/gi },
  { id: "polos", re: /\b(polo|poloer|polos)\b/gi },
  { id: "trousers", re: /\b(bukser|trousers?|chinos?|jeans?|slacks?)\b/gi },
  { id: "knitwear", re: /\b(strik|knitwear|sweaters?|cardigans?|pullover)\b/gi },
  { id: "outerwear", re: /\b(jakke|jakker|frakke|coat|jacket|blazer|parka|trench)\b/gi },
  { id: "watches", re: /\b(ur|ure|watches?|watch|chronograph|timepiece)\b/gi },
  { id: "accessories", re: /\b(tilbehor|accessories|belts?|wallet|scarf|ties?|cufflinks?)\b/gi },
  { id: "jewel_rings", re: /\b(ringe?|rings?)\b/gi },
  { id: "jewel_necklaces", re: /\b(halsk[aæ]de|necklace|pendant)\b/gi },
  { id: "jewel_bracelets", re: /\b(armb[aå]nd|bracelet|bangle)\b/gi },
  { id: "beauty_mascara", re: /\b(mascara)\b/gi },
  { id: "travel_luggage", re: /\b(kuffert|luggage|suitcase|carry[-\s]?on)\b/gi },
];

const DEFAULT_NEGATIVE = ["women", "kids", "child", "replica", "fake", "bulk"];
const OFFTOPIC_AUTOMOTIVE = [
  "car",
  "auto",
  "automotive",
  "vehicle",
  "truck",
  "engine",
  "bumper",
  "headlight",
  "taillight",
  "mirror",
  "detailing",
  "coating",
  "maintenance",
  "repair",
  "plastic",
];

const CATEGORY_SIGNAL_OVERRIDES = {
  shoes: {
    da: ["herresko", "laedersko", "klassiske sko"],
    en: ["mens leather shoes", "derby shoes", "oxford shoes", "loafers"],
    materials: ["leather", "suede"],
    styles: ["classic", "timeless", "minimal"],
    intents: ["formal", "business casual"],
    related: ["smart shoes", "dress shoes"],
    negative: ["women", "kids", "safety shoes", ...OFFTOPIC_AUTOMOTIVE],
  },
  footwear_boots: {
    da: ["stovler herre", "ankelstovler"],
    en: ["mens boots", "chelsea boots", "ankle boots"],
    materials: ["leather", "suede"],
    styles: ["timeless", "premium"],
    intents: ["winter", "urban"],
    negative: [...OFFTOPIC_AUTOMOTIVE, "workwear", "safety"],
  },
  footwear_sneakers: {
    da: ["sneakers herre", "hverdags sneakers"],
    en: ["mens sneakers", "minimal sneakers"],
    materials: ["leather", "mesh"],
    styles: ["clean", "minimal"],
    intents: ["everyday", "streetwear"],
    negative: OFFTOPIC_AUTOMOTIVE,
  },
  shirts: {
    negative: OFFTOPIC_AUTOMOTIVE,
  },
  polos: {
    negative: OFFTOPIC_AUTOMOTIVE,
  },
  knitwear: {
    negative: OFFTOPIC_AUTOMOTIVE,
  },
  trousers: {
    negative: OFFTOPIC_AUTOMOTIVE,
  },
  outerwear: {
    da: ["jakke herre", "frakke herre", "klassisk outerwear"],
    en: ["mens jacket", "mens coat", "mens outerwear"],
    materials: ["wool", "cotton", "leather"],
    styles: ["classic", "minimal"],
    intents: ["winter", "smart casual"],
    negative: OFFTOPIC_AUTOMOTIVE,
  },
  watches: {
    da: ["herreur", "klassiske ure"],
    en: ["wrist watch", "mens watch", "automatic watch"],
    materials: ["stainless steel", "leather strap"],
    styles: ["classic", "minimal"],
    intents: ["dress watch", "everyday watch"],
  },
  jewel_rings: {
    da: ["ringe", "smykke ring"],
    en: ["rings", "jewelry ring", "sterling silver ring"],
    materials: ["silver", "gold", "stainless steel"],
    styles: ["minimal", "elegant"],
    intents: ["gift", "daily wear"],
  },
  beauty_mascara: {
    da: ["mascara", "ojenvipper mascara"],
    en: ["mascara", "volumizing mascara", "lengthening mascara"],
    materials: ["waterproof", "vegan"],
    styles: ["clean beauty"],
    intents: ["daily makeup"],
    negative: ["used", "tester"],
  },
};

function normalizeText(v) {
  return String(v || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9æøå\s_-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function seededHash(str) {
  const s = String(str || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return Math.abs(h >>> 0);
}

function inferIntentCategory(text) {
  const t = normalizeText(text);
  if (!t) return null;
  let pos = -1;
  let id = null;
  for (const row of CATEGORY_KEYWORDS) {
    const rx = new RegExp(row.re.source, "gi");
    let m;
    while ((m = rx.exec(t)) !== null) {
      if (m.index >= pos) {
        pos = m.index;
        id = row.id;
      }
    }
  }
  return id ? normalizeCategoryId(id) : null;
}

function splitHintTokens(hint) {
  return normalizeText(hint)
    .split(/[^a-z0-9æøå]+/i)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && !WORD_STOP.has(x))
    .slice(0, 6);
}

function splitVibeKeywords(raw) {
  return String(raw || "")
    .split(/[,;\n]/)
    .map((x) => normalizeText(x))
    .filter((x) => x && x.length >= 2)
    .slice(0, 6);
}

function merchandisingSettings(storeConfig) {
  const cfg = storeConfig && typeof storeConfig === "object" ? storeConfig : {};
  const src = cfg.sourcing && cfg.sourcing.merchandising ? cfg.sourcing.merchandising : {};
  const assortmentFocus = normalizeText(cfg.assortment_focus || src.focus || "");
  const season = normalizeText(cfg.season || src.seasonNote || "");
  const vibeKeywords = splitVibeKeywords(cfg.vibe_keywords || src.vibeKeywords || "");
  return { assortmentFocus, season, vibeKeywords };
}

function categoryVertical(categoryId) {
  const id = normalizeCategoryId(categoryId);
  for (const v of STORE_VERTICALS) {
    if ((v.categoryIds || []).includes(id)) return v.key;
  }
  return "all";
}

function defaultSignalsFromCategory(categoryId) {
  const id = normalizeCategoryId(categoryId);
  const labelDa = String(LABELS_DA[id] || id).trim();
  const slugWords = id.split("_").filter(Boolean);
  const enBase = slugWords.join(" ").trim();
  return {
    id,
    labelDa,
    da: [labelDa.toLowerCase(), ...slugWords].filter(Boolean),
    en: enBase ? [enBase] : [],
    synonyms: [],
    related: [],
    materials: [],
    styles: [],
    intents: [],
    negative: [],
  };
}

function mergeSignals(categoryId) {
  const base = defaultSignalsFromCategory(categoryId);
  const o = CATEGORY_SIGNAL_OVERRIDES[base.id] || {};
  return {
    ...base,
    da: [...new Set([...(base.da || []), ...(o.da || [])])],
    en: [...new Set([...(base.en || []), ...(o.en || [])])],
    synonyms: [...new Set([...(o.synonyms || [])])],
    related: [...new Set([...(o.related || [])])],
    materials: [...new Set([...(o.materials || [])])],
    styles: [...new Set([...(o.styles || [])])],
    intents: [...new Set([...(o.intents || [])])],
    negative: [...new Set([...(DEFAULT_NEGATIVE || []), ...(o.negative || [])])],
  };
}

function activeCategories(storeConfig, categoryIntent) {
  const allowedRaw = Array.isArray(storeConfig && storeConfig.allowedCategories)
    ? storeConfig.allowedCategories
    : [];
  const allowed = [...new Set(allowedRaw.map((x) => normalizeCategoryId(x)).filter(Boolean))];
  const ci = categoryIntent ? normalizeCategoryId(categoryIntent) : null;
  if (ci && ci !== "other") {
    if (!allowed.length || allowed.includes(ci)) return [ci, ...allowed.filter((x) => x !== ci)];
    return [ci];
  }
  const lm = getLearningMemory(storeConfig);
  const losingCats = new Set((lm && lm.losing_categories) || []);
  const categoryPerf = Array.isArray(storeConfig && storeConfig.categoryPerformanceMemory)
    ? storeConfig.categoryPerformanceMemory
        .filter((x) => x && typeof x === "object")
        .map((x) => ({ category: normalizeCategoryId(x.category), score: Number(x.score) || 0 }))
        .filter((x) => x.category)
    : [];
  const scoreMap = new Map(categoryPerf.map((x) => [x.category, x.score]));
  if (allowed.length) {
    const filtered = allowed.filter((x) => !losingCats.has(normalizeCategoryId(x)));
    const ranked = (filtered.length ? filtered : allowed).sort((a, b) => (scoreMap.get(b) || 0) - (scoreMap.get(a) || 0));
    return ranked;
  }
  return [];
}

function buildVariantsForSignals(sig, hintTokens, settings = {}, trends = []) {
  const daCore = sig.da[0] || sig.labelDa || sig.id;
  const enCore = sig.en[0] || sig.id.replace(/_/g, " ");
  const style = sig.styles[0] || "";
  const material = sig.materials[0] || "";
  const intent = sig.intents[0] || "";
  const related = sig.related[0] || "";
  const hintTail = hintTokens.slice(0, 2).join(" ");
  const assortment = String(settings.assortmentFocus || "").trim();
  const season = String(settings.season || "").trim();
  const vibe = (settings.vibeKeywords || []).slice(0, 2).join(" ").trim();
  const catWord = enCore.replace(/\s+/g, " ").trim();
  const seasonalIntent = season && !intent ? season : intent;

  const lm = getLearningMemory(settings.storeConfig || null);
  const winKw = (lm && lm.winning_keywords) || [];
  const loseKw = new Set((lm && lm.losing_keywords) || []);
  const queryPerf = Array.isArray(settings.storeConfig && settings.storeConfig.queryPerformanceMemory)
    ? settings.storeConfig.queryPerformanceMemory
    : [];
  const minSample = Math.max(3, Number(process.env.DISCOVERY_MIN_SAMPLE_SIZE) || 8);
  const maxDays = Math.max(7, Number(process.env.DISCOVERY_QUERY_MAX_STALENESS_DAYS) || 120);
  const queryPerfMap = new Map(
    queryPerf
      .filter((x) => x && typeof x === "object")
      .map((x) => {
        const updatedAgeDays = x.updatedAt ? Math.max(0, (Date.now() - Date.parse(x.updatedAt)) / 86400000) : 9999;
        const freshness = clamp(1 - updatedAgeDays / maxDays, 0.25, 1);
        const sample = Number(x.sample_size) || 0;
        const confidence = sample >= minSample ? "high" : "low";
        return [
          normalizeText(x.query),
          {
            score: Number(x.score) || 0,
            confidence,
            sampleSize: sample,
            freshness,
          },
        ];
      })
      .filter((x) => x[0])
  );
  const raw = [
    { type: "base_da", q: daCore },
    { type: "base_en", q: enCore },
    { type: "synonym", q: [enCore, ...(sig.synonyms || [])].join(" ").trim() },
    { type: "related", q: [enCore, related].join(" ").trim() },
    { type: "intent", q: [enCore, intent].join(" ").trim() },
    { type: "material", q: [enCore, material].join(" ").trim() },
    { type: "style", q: [enCore, style].join(" ").trim() },
    { type: "broad", q: [enCore, style, material].join(" ").trim() },
    { type: "precise", q: [enCore, material, intent, "premium"].join(" ").trim() },
    { type: "hint", q: [enCore, hintTail].join(" ").trim() },
    { type: "settings_focus", q: [assortment, catWord].join(" ").trim() },
    { type: "settings_vibe_focus", q: [vibe, assortment, seasonalIntent, catWord].join(" ").trim() },
    { type: "settings_season", q: [season, catWord, "neutral colors"].join(" ").trim() },
    { type: "settings_luxury", q: [vibe, "luxury", catWord, season].join(" ").trim() },
    ...trends.slice(0, 4).map((t) => ({ type: "trend", q: t.keyword })),
    { type: "learning_boost", q: [vibe, enCore, ...winKw.slice(0, 3), "premium high quality"].join(" ").trim() },
  ];
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    const q = String(row.q || "").replace(/\s+/g, " ").trim();
    if ([...loseKw].some((kw) => kw && q.toLowerCase().includes(kw))) continue;
    if (!q || seen.has(q)) continue;
    seen.add(q);
    const qNorm = normalizeText(q);
    const perf = queryPerfMap.get(qNorm) || { score: 0, confidence: "low", sampleSize: 0, freshness: 1 };
    const perfScore = Number(perf.score) * Number(perf.freshness || 1);
    const confidenceBoost = perf.confidence === "low" ? 0.22 : 0;
    const qualityWeight = Number((1 + Math.max(-0.7, Math.min(1.8, perfScore / 100)) + confidenceBoost).toFixed(4));
    out.push({
      type: row.type,
      query: q,
      negative: sig.negative || [],
      qualityWeight,
      sampleSize: Number(perf.sampleSize) || 0,
      confidence: perf.confidence || "low",
      freshness: Number(perf.freshness || 1),
    });
  }
  return out.sort((a, b) => Number(b.qualityWeight || 1) - Number(a.qualityWeight || 1));
}

function selectQueriesWithExploreExploit(candidates, context = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return { queries: [], stats: null };
  const explorationRate = clamp(
    Number(
      (context.storeConfig && context.storeConfig.discoveryExplorationRate) ||
        process.env.DISCOVERY_EXPLORATION_RATE ||
        0.2
    ),
    0.05,
    0.6
  );
  const total = list.length;
  const exploreCount = Math.max(1, Math.round(total * explorationRate));
  const exploitCount = Math.max(1, total - exploreCount);

  const ranked = [...list].sort((a, b) => Number(b.qualityWeight || 1) - Number(a.qualityWeight || 1));
  const exploitPool = ranked.filter((x) => String(x.confidence || "low") === "high");
  const lowConfidencePool = ranked.filter((x) => String(x.confidence || "low") !== "high");
  const explorePool = [...lowConfidencePool, ...ranked.slice(Math.floor(ranked.length * 0.35))];

  function pickWithDiversity(pool, target, seedTag) {
    const out = [];
    const catCounts = new Map();
    const typeCounts = new Map();
    const maxPerCategory = Math.max(2, Math.ceil(target * 0.45));
    const maxPerType = Math.max(2, Math.ceil(target * 0.55));
    const shuffled = [...pool].sort((a, b) => {
      const ha = seededHash(`${seedTag}:${a.query}:${a.categoryId}:${a.type}`);
      const hb = seededHash(`${seedTag}:${b.query}:${b.categoryId}:${b.type}`);
      return ha - hb;
    });
    for (const item of shuffled) {
      if (out.length >= target) break;
      const cat = String(item.categoryId || "other");
      const typ = String(item.type || "unknown");
      if ((catCounts.get(cat) || 0) >= maxPerCategory) continue;
      if ((typeCounts.get(typ) || 0) >= maxPerType) continue;
      if (out.some((x) => x.query === item.query)) continue;
      out.push(item);
      catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
      typeCounts.set(typ, (typeCounts.get(typ) || 0) + 1);
    }
    if (out.length < target) {
      for (const item of pool) {
        if (out.length >= target) break;
        if (out.some((x) => x.query === item.query)) continue;
        out.push(item);
      }
    }
    return out;
  }

  const exploitPicked = pickWithDiversity(exploitPool.length ? exploitPool : ranked, exploitCount, "exploit").map((q) => ({
    ...q,
    selectionMode: "exploit",
  }));
  const explorePicked = pickWithDiversity(explorePool.length ? explorePool : ranked, exploreCount, "explore").map((q) => ({
    ...q,
    selectionMode: "explore",
  }));
  const merged = [...exploitPicked, ...explorePicked];
  const uniq = new Map();
  for (const q of merged) {
    if (!uniq.has(q.query)) uniq.set(q.query, q);
  }
  const selected = [...uniq.values()];
  const confidenceMix = selected.reduce(
    (acc, q) => {
      const c = String(q.confidence || "low");
      if (c === "high") acc.high += 1;
      else acc.low += 1;
      return acc;
    },
    { high: 0, low: 0 }
  );
  return {
    queries: selected,
    stats: {
      explorationRate: Number(explorationRate.toFixed(4)),
      requestedTotal: total,
      selectedTotal: selected.length,
      exploitSelected: exploitPicked.length,
      exploreSelected: explorePicked.length,
      confidenceMix,
    },
  };
}

function generateCategoryQueryPack(input) {
  const storeConfig = input && input.storeConfig ? input.storeConfig : null;
  const categoryIntent = input ? input.categoryIntent : null;
  const chatSearchHint = input ? input.chatSearchHint : "";
  const cats = activeCategories(storeConfig, categoryIntent).slice(0, 14);
  const hintTokens = splitHintTokens(chatSearchHint);
  const settings = merchandisingSettings(storeConfig);
  settings.storeConfig = storeConfig;
  const learning = getLearningMemory(storeConfig);
  const packs = cats.map((id) => {
    const sig = mergeSignals(id);
    const trends = buildTrendSignals({
      category: id,
      season: settings.season,
      vibeKeywords: settings.vibeKeywords,
    });
    return {
      categoryId: id,
      vertical: categoryVertical(id),
      signals: sig,
      variants: buildVariantsForSignals(sig, hintTokens, settings, trends),
      trends,
    };
  });
  const trendList = packs
    .flatMap((p) => p.trends || [])
    .sort((a, b) => Number(b.trend_score || 0) - Number(a.trend_score || 0))
    .slice(0, 24);
  const rewriteMemory = Array.isArray(storeConfig && storeConfig.queryRewriteMemory)
    ? storeConfig.queryRewriteMemory
        .filter((x) => x && typeof x === "object")
        .map((x) => ({ query: String(x.query || "").trim().toLowerCase(), suggestion: String(x.suggestion || "").trim() }))
        .filter((x) => x.query && x.suggestion)
        .slice(0, 200)
    : [];
  if (rewriteMemory.length) {
    for (const p of packs) {
      const categoryToken = String(p.categoryId || "").replace(/_/g, " ");
      const additions = rewriteMemory
        .filter((rw) => rw.query.includes(categoryToken))
        .slice(0, 3)
        .map((rw) => ({ type: "feedback_rewrite", query: rw.suggestion, negative: [] }));
      if (additions.length) {
        p.variants = [...p.variants, ...additions];
      }
    }
  }
  return {
    categories: cats,
    packs,
    hintTokens,
    settings,
    debug: {
      categories: cats,
      categoryIntent: categoryIntent ? normalizeCategoryId(categoryIntent) : null,
      hintTokens,
      settings,
      trends: trendList,
      learning,
      rewriteMemoryCount: rewriteMemory.length,
    },
  };
}

function buildEbayQueries(input) {
  const pack = generateCategoryQueryPack(input);
  const allCandidates = [];
  for (const p of pack.packs) {
    for (const v of p.variants.slice(0, 8)) {
      const q = [v.query, p.signals.styles[0] || "", p.signals.intents[0] || ""]
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 118);
      if (!q) continue;
      allCandidates.push({
        categoryId: p.categoryId,
        type: v.type,
        query: q,
        negative: v.negative || [],
        qualityWeight: Number(v.qualityWeight || 1),
        confidence: v.confidence || "low",
        sampleSize: Number(v.sampleSize) || 0,
        freshness: Number(v.freshness || 1),
      });
    }
  }
  const selection = selectQueriesWithExploreExploit(allCandidates, { storeConfig: input && input.storeConfig });
  const out = selection.queries || [];
  if (out.length) {
    out.sort((a, b) => Number(b.qualityWeight || 1) - Number(a.qualityWeight || 1));
  }
  if (!out.length) {
    out.push({
      categoryId: "other",
      type: "fallback",
      query: String(process.env.EBAY_DISCOVERY_QUERY || "collectibles").split(/[,;|\n]+/)[0].trim() || "collectibles",
      negative: DEFAULT_NEGATIVE,
    });
  }
  return {
    queries: out,
    debug: {
      ...pack.debug,
      exploration: selection.stats || null,
    },
  };
}

module.exports = {
  inferIntentCategory,
  generateCategoryQueryPack,
  buildEbayQueries,
};

