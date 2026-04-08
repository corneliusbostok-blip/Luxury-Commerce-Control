"use strict";

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function normalizeImages(rawImages, fallbackImage = "") {
  const arr = Array.isArray(rawImages) ? rawImages : rawImages ? [rawImages] : [];
  const out = [];
  const seen = new Set();
  for (const item of [...arr, fallbackImage]) {
    const u = String(item || "").trim();
    if (!u) continue;
    if (!/^https?:\/\//i.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out.slice(0, 20);
}

function normalizeVariants(rawVariants, fallback = {}) {
  const list = Array.isArray(rawVariants) ? rawVariants : [];
  const out = [];
  const seen = new Set();
  for (const v of list) {
    const row = v && typeof v === "object" ? v : {};
    const size = String(row.size || row.option1 || row.title || fallback.size || "").trim() || null;
    const color = String(row.color || row.option2 || fallback.color || "").trim() || null;
    const price = n(row.price, n(fallback.price));
    const available = row.available == null ? true : Boolean(row.available);
    const key = `${String(size || "")}|${String(color || "")}|${String(price)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ size, color, price, available });
  }
  if (!out.length) {
    out.push({
      size: String(fallback.size || "unknown").trim() || "unknown",
      color: String(fallback.color || "").trim() || null,
      price: n(fallback.price),
      available: fallback.available == null ? true : Boolean(fallback.available),
    });
  }
  return out.slice(0, 120);
}

function summarizeSizesFromVariants(variants) {
  const s = new Set();
  for (const v of Array.isArray(variants) ? variants : []) {
    const size = String(v && v.size ? v.size : "").trim();
    if (!size || size === "unknown") continue;
    s.add(size);
  }
  return [...s].slice(0, 20).join(",") || "unknown";
}

function inferPrimaryColorFromVariants(variants, fallbackColor = "") {
  for (const v of Array.isArray(variants) ? variants : []) {
    const color = String(v && v.color ? v.color : "").trim();
    if (color) return color;
  }
  return String(fallbackColor || "").trim() || "";
}

function hasAvailableVariant(variants) {
  return (Array.isArray(variants) ? variants : []).some((v) => v && v.available === true);
}

module.exports = {
  normalizeImages,
  normalizeVariants,
  summarizeSizesFromVariants,
  inferPrimaryColorFromVariants,
  hasAvailableVariant,
};

