/**
 * Kategori-slugs: inferens fra titel + normalisering til katalog.
 * Udvidet taxonomi: server/services/store-taxonomy.js
 * Rækkefølge: specifikke nye mønstre først, derefter eksisterende herre-/bolig-slugs.
 */

const { CATEGORY_META_EXTENDED } = require("./store-taxonomy");

const CATEGORY_META_LEGACY = [
  { id: "outerwear", label: "Overtøj", patterns: [/jacket/i, /coat/i, /blazer/i, /parka/i, /peacoat/i, /overcoat/i, /trench/i] },
  {
    id: "polos",
    label: "Polos",
    patterns: [/\bpolo\b/i, /\bpolos\b/i],
  },
  {
    id: "shirts",
    label: "Skjorter",
    patterns: [/shirt/i, /poplin/i, /linen\s+shirt/i],
  },
  {
    id: "knitwear",
    label: "Strik",
    patterns: [/sweater/i, /cardigan/i, /cashmere/i, /merino/i, /pullover/i, /crewneck/i, /v-neck/i, /knitwear/i, /\bknit\b/i],
  },
  { id: "trousers", label: "Bukser", patterns: [/trouser/i, /chino/i, /\bpant/i, /denim/i, /\bjean/i, /slack/i] },
  {
    id: "shoes",
    label: "Sko",
    patterns: [
      /\bsko\b/i,
      /\bloafer/i,
      /derby/i,
      /oxford\s+shoe/i,
      /\bshoe/i,
      /boot\b/i,
      /chelsea\s+boot/i,
      /sneaker/i,
      /trainer\b/i,
    ],
  },
  {
    id: "watches",
    label: "Ure",
    patterns: [/watch/i, /chronograph/i, /timepiece/i, /\bsmall\s+seconds\b/i],
  },
  {
    id: "accessories",
    label: "Tilbehør",
    patterns: [/belt/i, /wallet/i, /scarf/i, /\btie\b/i, /cufflink/i, /sunglasses/i, /bag/i, /briefcase/i, /tote/i, /messenger/i],
  },
  {
    id: "lighting",
    label: "Lamper & belysning",
    patterns: [
      /pendant/i,
      /chandelier/i,
      /ceiling\s+light/i,
      /wall\s+light/i,
      /table\s+lamp/i,
      /floor\s+lamp/i,
      /belysning/i,
      /\blamp\b/i,
      /sconce/i,
      /\bled\b/i,
      /spotlight/i,
    ],
  },
  {
    id: "furniture",
    label: "Møbler",
    patterns: [/sofa/i, /couch/i, /armchair/i, /dining\s+table/i, /coffee\s+table/i, /bookshelf/i, /cabinet/i, /wardrobe/i, /møbel/i, /\bstol\b/i, /skrivebord/i],
  },
  {
    id: "home_decor",
    label: "Indretning",
    patterns: [/vase/i, /mirror/i, /wall\s+art/i, /picture\s+frame/i, /candleholder/i, /dekoration/i, /plakat/i, /poster\b/i, /figurine/i, /pynte/i],
  },
  {
    id: "kitchen",
    label: "Køkken",
    patterns: [/cookware/i, /køkken/i, /køkkenudstyr/i, /pot\b/i, /\bpan\b/i, /cutting\s+board/i, /kande/i, /bakke\b/i],
  },
  {
    id: "home_textiles",
    label: "Tekstiler",
    patterns: [/curtain/i, /cushion/i, /throw\b/i, /rug\b/i, /plaid/i, /sengetøj/i, /gardin/i, /pude\b/i, /bedding/i],
  },
];

const CATEGORY_META = [...CATEGORY_META_EXTENDED, ...CATEGORY_META_LEGACY];

const LABEL_BY_ID = Object.fromEntries(CATEGORY_META.map((c) => [c.id, c.label]));
LABEL_BY_ID.other = "Andet";

const VALID_IDS = new Set([...CATEGORY_META.map((c) => c.id), "other"]);

/** Map legacy slugs from older catalog rows */
const LEGACY_CATEGORY_MAP = {
  footwear: "shoes",
  bags: "accessories",
};

/** Forside — diversificeret udvalg */
const FEATURED_COLLECTION_IDS = ["womens_tops", "mens_shirts_tees", "footwear_sneakers", "home_decor", "elec_laptops"];

function listCategoriesMeta() {
  return [...CATEGORY_META, { id: "other", label: "Andet" }];
}

function categoryLabel(id) {
  if (!id) return LABEL_BY_ID.other;
  const normalized = normalizeCategoryId(id);
  return LABEL_BY_ID[normalized] || LABEL_BY_ID.other;
}

function normalizeCategoryId(id) {
  if (id == null || id === "") return "other";
  const x = String(id).trim().toLowerCase();
  if (LEGACY_CATEGORY_MAP[x]) return LEGACY_CATEGORY_MAP[x];
  if (VALID_IDS.has(x)) return x;
  return "other";
}

function inferCategory(title, hint) {
  if (hint != null && String(hint).trim()) {
    const n = normalizeCategoryId(hint);
    if (n !== "other") return n;
  }
  const t = String(title || "");
  for (const { id, patterns } of CATEGORY_META) {
    if (patterns.some((re) => re.test(t))) return id;
  }
  return "other";
}

function enrichProduct(p) {
  if (!p) return p;
  const cat = normalizeCategoryId(p.category || "other");
  const sizesStr = p.sizes != null && String(p.sizes).trim() ? String(p.sizes).trim() : "S,M,L,XL";
  const sizeOptions = sizesStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const imagesRaw = Array.isArray(p.image_urls)
    ? p.image_urls
    : typeof p.image_urls === "string"
    ? (() => {
        try {
          const j = JSON.parse(p.image_urls);
          return Array.isArray(j) ? j : [];
        } catch {
          return [];
        }
      })()
    : [];
  const images = imagesRaw.length ? imagesRaw : p.image_url ? [p.image_url] : [];
  const variantsRaw = Array.isArray(p.supplier_variants)
    ? p.supplier_variants
    : typeof p.supplier_variants === "string"
    ? (() => {
        try {
          const j = JSON.parse(p.supplier_variants);
          return Array.isArray(j) ? j : [];
        } catch {
          return [];
        }
      })()
    : [];
  return {
    ...p,
    title: p.name != null ? String(p.name) : "",
    category: cat,
    categoryLabel: categoryLabel(cat),
    color: p.color != null ? String(p.color).trim() : "",
    sizes: sizesStr,
    sizeOptions,
    images,
    variants: variantsRaw,
    available: p.available !== false,
    availability_reason: String(p.availability_reason || ""),
  };
}

function inferProductColor(title) {
  const t = String(title || "").toLowerCase();
  const pairs = [
    ["taupe", "Taupe"],
    ["burgundy", "Burgundy"],
    ["charcoal", "Charcoal"],
    ["navy", "Navy"],
    ["forest", "Forest"],
    ["olive", "Olive"],
    ["camel", "Camel"],
    ["ecru", "Ecru"],
    ["beige", "Beige"],
    ["cream", "Cream"],
    ["brown", "Brown"],
    ["black", "Black"],
    ["grey", "Grey"],
    ["gray", "Grey"],
    ["white", "White"],
    ["tan", "Tan"],
    ["green", "Green"],
    ["blue", "Blue"],
    ["red", "Red"],
    ["stone", "Stone"],
  ];
  for (const [key, label] of pairs) {
    if (t.includes(key)) return label;
  }
  return "Stone";
}

module.exports = {
  CATEGORY_META,
  FEATURED_COLLECTION_IDS,
  listCategoriesMeta,
  categoryLabel,
  inferCategory,
  inferProductColor,
  enrichProduct,
  normalizeCategoryId,
  VALID_CATEGORY_IDS: [...VALID_IDS],
};
