/**
 * Merge same-style products that differ only by colour (e.g. Mid Green / Taupe Slim Leg Straight Chinos).
 */

const { normalizeCategoryId, inferProductColor } = require("./category");

const MODIFIERS = new Set(["mid", "light", "dark", "vintage", "washed", "soft", "bright", "deep", "pale"]);

const COLOR_WORDS = new Set([
  "navy",
  "charcoal",
  "black",
  "grey",
  "gray",
  "beige",
  "ecru",
  "camel",
  "brown",
  "olive",
  "cream",
  "white",
  "burgundy",
  "tan",
  "forest",
  "stone",
  "taupe",
  "green",
  "blue",
  "red",
  "pink",
  "yellow",
  "orange",
  "purple",
  "sand",
  "khaki",
  "indigo",
  "slate",
  "ivory",
  "natural",
  "coral",
  "lilac",
  "rose",
  "gold",
  "silver",
  "bronze",
  "mint",
  "aqua",
  "teal",
  "wine",
  "mustard",
  "ochre",
  "salmon",
  "chocolate",
  "chalk",
  "snow",
  "ink",
  "multi",
  "neutral",
]);

/**
 * Strip leading colour tokens so "Mid Green Slim Leg Straight Chinos" → "Slim Leg Straight Chinos".
 */
function canonicalProductName(title) {
  const parts = String(title || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;
  while (i < parts.length) {
    const raw = parts[i];
    const w = raw.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "").toLowerCase();
    const twoRaw =
      i + 1 < parts.length ? `${parts[i]} ${parts[i + 1]}`.toLowerCase().replace(/\s+/g, " ").trim() : "";
    if (twoRaw === "off-white" || twoRaw === "off white") {
      i += 2;
      continue;
    }
    if (MODIFIERS.has(w)) {
      i += 1;
      continue;
    }
    if (COLOR_WORDS.has(w)) {
      i += 1;
      continue;
    }
    break;
  }
  const rest = parts.slice(i).join(" ").trim();
  return rest || String(title || "").trim();
}

function styleKeyFromTitle(title, category) {
  const cat = normalizeCategoryId(category);
  const base = canonicalProductName(title);
  const slug = base
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!slug) return "";
  return `${cat}|${slug}`;
}

function parseColorVariants(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === "string") {
    try {
      const j = JSON.parse(raw);
      return Array.isArray(j) ? j.filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function variantSnapshotFromRowFragment(row) {
  return {
    color: String(row.color || "").trim() || inferProductColor(row.name || ""),
    price: Number(row.price) || 0,
    cost: Number(row.cost) || 0,
    image_url: row.image_url || "",
    external_id: String(row.external_id || "").trim(),
    source_url: row.source_url || "",
    source_product_id: row.source_product_id || "",
  };
}

function snapshotsEqualExt(a, b) {
  return a && b && a.external_id && a.external_id === b.external_id;
}

/**
 * All colour options including the primary columns as index 0.
 */
function expandVariantsForProduct(p) {
  const primary = variantSnapshotFromRowFragment(p);
  const extras = parseColorVariants(p.color_variants);
  const out = [];
  const seen = new Set();

  function pushV(v) {
    const ext = String(v.external_id || "").trim();
    if (ext) {
      if (seen.has("e:" + ext)) return;
      seen.add("e:" + ext);
    } else {
      const k = "c:" + String(v.color || "").toLowerCase() + ":" + String(Number(v.price) || 0);
      if (seen.has(k)) return;
      seen.add(k);
    }
    out.push({
      color: String(v.color || "").trim(),
      price: Number(v.price) || 0,
      cost: Number(v.cost) || 0,
      image_url: v.image_url || "",
      external_id: ext,
      source_url: v.source_url || "",
      source_product_id: v.source_product_id || "",
    });
  }

  pushV(primary);
  for (const v of extras) pushV(v);
  return out;
}

/** Sale price (major units) for storefront / checkout — respects colour variant. */
function resolvedSalePriceMajor(product, colorHint) {
  const col = String(colorHint || "").trim().toLowerCase();
  if (!col) return Number(product.price) || 0;
  const list = expandVariantsForProduct(product);
  const hit = list.find((v) => String(v.color || "").trim().toLowerCase() === col);
  if (hit && hit.price != null && !Number.isNaN(Number(hit.price))) return Number(hit.price);
  return Number(product.price) || 0;
}

function productHasColorVariant(p, colorQuery) {
  const q = String(colorQuery || "").trim().toLowerCase();
  if (!q) return true;
  const all = expandVariantsForProduct(p);
  return all.some((v) => (v.color || "").toLowerCase() === q);
}

async function loadExternalIdSet(supabase) {
  const s = new Set();
  if (!supabase) return s;
  const { data, error } = await supabase.from("products").select("external_id, color_variants");
  if (error) return s;
  for (const r of data || []) {
    if (r.external_id) s.add(String(r.external_id));
    for (const v of parseColorVariants(r.color_variants)) {
      if (v && v.external_id) s.add(String(v.external_id));
    }
  }
  return s;
}

async function findStyleMergeRow(supabase, category, styleKey) {
  if (!supabase || !styleKey) return null;
  const cat = normalizeCategoryId(category);
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("category", cat)
    .eq("style_key", styleKey)
    .neq("status", "removed")
    .limit(1);
  if (error || !data?.length) return null;
  return data[0];
}

/**
 * Add multi-colour fields for API/shop (raw row + already enriched base).
 */
function augmentEnrichedProduct(raw, enriched) {
  if (!enriched) return enriched;
  const list = expandVariantsForProduct(raw || enriched);
  const colors = [...new Set(list.map((v) => v.color).filter(Boolean))];
  const n = colors.length;
  return {
    ...enriched,
    colorVariants: list,
    colorOptionCount: n,
    shopColorLabel: n > 1 ? `${n} farver` : enriched.color || "",
  };
}

module.exports = {
  canonicalProductName,
  styleKeyFromTitle,
  parseColorVariants,
  expandVariantsForProduct,
  resolvedSalePriceMajor,
  productHasColorVariant,
  variantSnapshotFromRowFragment,
  snapshotsEqualExt,
  loadExternalIdSet,
  findStyleMergeRow,
  augmentEnrichedProduct,
};
