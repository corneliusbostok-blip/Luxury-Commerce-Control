"use strict";

const cheerio = require("cheerio");
const { normalizeImages, normalizeVariants, hasAvailableVariant } = require("./product-sync-normalizer");
const { inferProductColor } = require("./category");
const { FixedWindowRateLimiter } = require("./sourcing/providers/rate-limiter");

const limiter = new FixedWindowRateLimiter({
  maxRequests: Number(process.env.SUPPLIER_SYNC_RATE_LIMIT_PER_SEC) || 3,
  windowMs: 1000,
});

function parseAvailabilityText(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  if (/out of stock|sold out|udsolgt|unavailable/.test(t)) return false;
  if (/in stock|available|på lager|in-stock/.test(t)) return true;
  return null;
}

function extractFromHtml(html, sourceUrl, fallback = {}) {
  const $ = cheerio.load(html);
  const imgs = [];
  $("img[src]").each((_, el) => {
    const s = String($(el).attr("src") || "").trim();
    if (s) imgs.push(s);
  });
  const title = String($("title").first().text() || fallback.name || "").trim();
  const availabilityMeta =
    $('meta[property="product:availability"]').attr("content") ||
    $('meta[name="availability"]').attr("content") ||
    "";
  const availability = parseAvailabilityText(availabilityMeta || $("body").text().slice(0, 3000));
  const images = normalizeImages(imgs, fallback.image_url || "");
  const variants = normalizeVariants([], {
    size: "unknown",
    color: inferProductColor(title || fallback.name || ""),
    price: Number(fallback.price) || 0,
    available: availability == null ? true : Boolean(availability),
  });
  return {
    images,
    variants,
    available: hasAvailableVariant(variants),
    availability_reason: hasAvailableVariant(variants) ? "" : "supplier_out_of_stock",
    supplier_sync_error: "",
    supplier_last_checked_at: new Date().toISOString(),
  };
}

async function fetchSupplierSnapshot(product) {
  const url = String(product && product.source_url ? product.source_url : "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return {
      images: normalizeImages([], product.image_url || ""),
      variants: normalizeVariants(product.supplier_variants, {
        size: "unknown",
        color: product.color || null,
        price: Number(product.price) || 0,
        available: product.available !== false,
      }),
      available: product.available !== false,
      availability_reason: product.available === false ? "supplier_out_of_stock" : "",
      supplier_sync_error: "invalid_source_url",
      supplier_last_checked_at: new Date().toISOString(),
    };
  }

  await limiter.take();
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        process.env.DISCOVERY_USER_AGENT ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  }).catch(() => null);
  if (!res || !res.ok) {
    return {
      images: normalizeImages([], product.image_url || ""),
      variants: normalizeVariants(product.supplier_variants, {
        size: "unknown",
        color: product.color || null,
        price: Number(product.price) || 0,
        available: product.available !== false,
      }),
      available: product.available !== false,
      availability_reason: product.available === false ? "supplier_out_of_stock" : "",
      supplier_sync_error: res ? `http_${res.status}` : "fetch_failed",
      supplier_last_checked_at: new Date().toISOString(),
    };
  }
  const html = await res.text().catch(() => "");
  return extractFromHtml(html, url, product || {});
}

async function syncSupplierStateForProduct(supabase, product) {
  if (!supabase || !product || !product.id) return null;
  const snap = await fetchSupplierSnapshot(product);
  const imageUrls = normalizeImages(snap.images, product.image_url || "");
  const variants = normalizeVariants(snap.variants, {
    size: "unknown",
    color: product.color || null,
    price: Number(product.price) || 0,
    available: snap.available !== false,
  });
  const anyAvailable = hasAvailableVariant(variants);
  const patch = {
    image_url: imageUrls[0] || product.image_url || "",
    image_urls: imageUrls,
    supplier_variants: variants,
    available: anyAvailable,
    availability_reason: anyAvailable ? "" : "supplier_out_of_stock",
    supplier_last_checked_at: snap.supplier_last_checked_at || new Date().toISOString(),
    supplier_sync_error: String(snap.supplier_sync_error || ""),
    status: anyAvailable ? product.status : "inactive",
    updated_at: new Date().toISOString(),
  };
  await supabase.from("products").update(patch).eq("id", product.id);
  return { id: product.id, available: anyAvailable, variants: variants.length };
}

async function runSupplierStockSync(supabase, opts = {}) {
  if (!supabase) return { ok: false, reason: "db_unavailable", checked: 0, updated: 0 };
  const intervalMin = Math.max(15, Math.min(120, Number(opts.intervalMin || process.env.SUPPLIER_SYNC_INTERVAL_MIN) || 30));
  const batchSize = Math.max(5, Math.min(200, Number(opts.batchSize || process.env.SUPPLIER_SYNC_BATCH_SIZE) || 40));
  const cutoffIso = new Date(Date.now() - intervalMin * 60000).toISOString();
  const { data, error } = await supabase
    .from("products")
    .select("id, name, status, price, color, image_url, image_urls, supplier_variants, source_url, available, supplier_last_checked_at")
    .neq("status", "removed")
    .or(`supplier_last_checked_at.is.null,supplier_last_checked_at.lt.${cutoffIso}`)
    .order("supplier_last_checked_at", { ascending: true, nullsFirst: true })
    .limit(batchSize);
  if (error) return { ok: false, reason: error.message || "query_failed", checked: 0, updated: 0 };
  const rows = data || [];
  let updated = 0;
  for (const p of rows) {
    const out = await syncSupplierStateForProduct(supabase, p);
    if (out) updated += 1;
  }
  return { ok: true, checked: rows.length, updated, intervalMin, batchSize };
}

module.exports = {
  runSupplierStockSync,
  syncSupplierStateForProduct,
};

