"use strict";

const BAD_IMAGE_TOKENS = ["placeholder", "logo", "icon", "thumbnail"];
const MIN_IMAGE_WIDTH = 500;

function absolutize(url, baseUrl) {
  try {
    return new URL(String(url || "").trim(), baseUrl).href;
  } catch {
    return "";
  }
}

function improveImageUrlQuality(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  let next = raw;
  next = next.replace(/([?&])width=\d+/gi, "$1width=1000");
  next = next.replace(/([?&])w=\d+/gi, "$1w=1000");
  next = next.replace(/([?&])size=small\b/gi, "$1size=large");
  next = next.replace(/\/s-l\d{2,4}\.(jpg|jpeg|png|webp)(\?|$)/i, "/s-l1600.$1$2");
  return next;
}

function estimateImageWidth(url) {
  const s = String(url || "");
  const mQuery = s.match(/[?&](?:w|width)=(\d{2,4})\b/i);
  if (mQuery) return Number(mQuery[1]) || 0;
  const mDim = s.match(/(\d{2,4})x(\d{2,4})/i);
  if (mDim) return Number(mDim[1]) || 0;
  const mTrailing = s.match(/[_-](\d{2,4})\.(?:jpe?g|png|webp|gif)(?:$|\?)/i);
  if (mTrailing) return Number(mTrailing[1]) || 0;
  return 0;
}

function parseSrcsetCandidates(srcset, baseUrl) {
  const entries = String(srcset || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const out = [];
  for (const e of entries) {
    const parts = e.split(/\s+/).filter(Boolean);
    const u = absolutize(parts[0], baseUrl);
    if (!u) continue;
    let width = 0;
    const token = parts[1] || "";
    const mW = token.match(/^(\d+)w$/i);
    if (mW) width = Number(mW[1]) || 0;
    if (!width) width = estimateImageWidth(u);
    out.push({ url: improveImageUrlQuality(u), width });
  }
  out.sort((a, b) => b.width - a.width);
  return out;
}

function isValidProductImage(url) {
  const raw = String(url || "").trim();
  if (!raw) return { ok: false, reason: "empty_url", width: 0, url: "" };
  if (!/^https?:\/\//i.test(raw)) return { ok: false, reason: "non_http_url", width: 0, url: raw };
  const low = raw.toLowerCase();
  if (BAD_IMAGE_TOKENS.some((t) => low.includes(t))) {
    return { ok: false, reason: "blocked_keyword", width: estimateImageWidth(raw), url: raw };
  }
  if (/^https?:\/\/ir\.ebaystatic\.com\/f\//i.test(raw)) {
    return { ok: false, reason: "blocked_ebay_fallback_sprite", width: estimateImageWidth(raw), url: raw };
  }
  if (/\/thumbs\/images\//i.test(low)) {
    return { ok: false, reason: "blocked_thumb_path", width: estimateImageWidth(raw), url: raw };
  }
  const width = estimateImageWidth(raw);
  if (width > 0 && width < MIN_IMAGE_WIDTH) {
    return { ok: false, reason: "too_small", width, url: raw };
  }
  return { ok: true, reason: "ok", width, url: improveImageUrlQuality(raw) };
}

function chooseBestProductImage(candidates = []) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const c of candidates || []) {
    const u = improveImageUrlQuality(String(c && c.url ? c.url : c || "").trim());
    if (!u || seen.has(u)) continue;
    seen.add(u);
    const verdict = isValidProductImage(u);
    if (!verdict.ok) {
      rejected.push(verdict);
      continue;
    }
    accepted.push(verdict);
  }
  accepted.sort((a, b) => (b.width || 0) - (a.width || 0));
  return {
    image: accepted[0] ? accepted[0].url : "",
    accepted,
    rejected,
  };
}

function extractImageCandidatesFromDocument($, baseUrl) {
  const out = [];
  $("img").each((_, el) => {
    const srcset = $(el).attr("srcset") || "";
    if (srcset) out.push(...parseSrcsetCandidates(srcset, baseUrl).map((x) => x.url));
    const dataSrc = absolutize($(el).attr("data-src") || "", baseUrl);
    if (dataSrc) out.push(improveImageUrlQuality(dataSrc));
    const dataOriginal = absolutize($(el).attr("data-original") || "", baseUrl);
    if (dataOriginal) out.push(improveImageUrlQuality(dataOriginal));
    const src = absolutize($(el).attr("src") || "", baseUrl);
    if (src) out.push(improveImageUrlQuality(src));
  });
  return out;
}

module.exports = {
  parseSrcsetCandidates,
  isValidProductImage,
  chooseBestProductImage,
  extractImageCandidatesFromDocument,
  improveImageUrlQuality,
};

