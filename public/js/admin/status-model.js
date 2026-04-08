/**
 * Normalized product row + structured status (no concatenated "Approvedscaling" strings).
 */

/** @param {string} raw */
export function parseCompositeSourcingStatus(raw) {
  let s = String(raw || "")
    .toLowerCase()
    .replace(/[\s_\-]+/g, "");
  const tokens = [];
  while (s.length) {
    if (s.startsWith("missingsource")) {
      tokens.push("missing_meta");
      s = s.slice(13);
      continue;
    }
    if (s.startsWith("approved")) {
      tokens.push("approved");
      s = s.slice(8);
      continue;
    }
    if (s.startsWith("rejected")) {
      tokens.push("rejected");
      s = s.slice(8);
      continue;
    }
    if (s.startsWith("draft")) {
      tokens.push("draft");
      s = s.slice(5);
      continue;
    }
    if (s.startsWith("scaling")) {
      tokens.push("scaling");
      s = s.slice(7);
      continue;
    }
    if (s.startsWith("removed")) {
      tokens.push("removed");
      s = s.slice(7);
      continue;
    }
    if (s.startsWith("active")) {
      tokens.push("active");
      s = s.slice(6);
      continue;
    }
    if (s.startsWith("missing")) {
      tokens.push("missing");
      s = s.slice(7);
      continue;
    }
    s = s.slice(1);
  }
  return tokens;
}

export function primarySourcingSlugFromRaw(raw) {
  const t = parseCompositeSourcingStatus(raw);
  if (t.includes("approved")) return "approved";
  if (t.includes("rejected")) return "rejected";
  if (t.includes("draft")) return "draft";
  const x = String(raw || "")
    .toLowerCase()
    .trim();
  if (["approved", "draft", "rejected"].includes(x)) return x;
  return x || "";
}

/**
 * @param {object} r
 * @returns {object | null}
 */
export function normalizeProductRow(r) {
  if (!r) return null;
  const sourcingRaw = String(r.sourcing_status || "").toLowerCase();
  return {
    id: r.id,
    title: r.title || r.name || "",
    name: r.name || r.title || "",
    category: r.category,
    categoryLabel: r.categoryLabel,
    price: r.price,
    image: r.image_url || r.image || "",
    sourcingStatusRaw: sourcingRaw,
    sourcingPrimary: primarySourcingSlugFromRaw(sourcingRaw),
    opsStatus: String(r.status || "").toLowerCase(),
    sourcePlatform: (r.source_platform || r.sourcePlatform || "").trim(),
    sourceName: (r.source_name || r.sourceName || "").trim(),
    sourceUrl: (r.source_url || r.sourceUrl || "").trim(),
    sourceProductId: (r.source_product_id || r.sourceProductId || r.external_id || "").trim(),
    supplierName: (r.supplier_name || r.supplierName || "").trim(),
    supplierCountry: (r.supplier_country || r.supplierCountry || "").trim(),
    importMethod: (r.import_method || r.importMethod || "").trim(),
    aiScore: r.ai_fit_score != null ? r.ai_fit_score : r.aiScore,
    brandFitReason: (r.brand_fit_reason || r.brandFitReason || "").trim(),
    _raw: r,
  };
}

export function hasCompleteSource(p) {
  return Boolean(p.sourceUrl && p.sourcePlatform);
}

/**
 * Independent status chips for UI (never one concatenated string).
 * @param {object} p normalized row
 * @param {Set<string>} scaleIdSet
 * @returns {Array<{ key: string, label: string, tone: string }>}
 */
export function buildStatusDescriptors(p, scaleIdSet) {
  const set = scaleIdSet instanceof Set ? scaleIdSet : new Set(scaleIdSet || []);
  const sourcingTokens = parseCompositeSourcingStatus(p.sourcingStatusRaw);
  const out = [];
  const seen = new Set();

  function push(key, label, tone) {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, label, tone });
  }

  if (!hasCompleteSource(p)) push("missing-source", "Missing source", "warning");

  if (sourcingTokens.includes("approved")) push("approved", "Approved", "success");
  else if (sourcingTokens.includes("rejected")) push("rejected", "Rejected", "danger");
  else if (sourcingTokens.includes("draft")) push("draft", "Draft", "neutral");
  else if (p.sourcingPrimary && ["approved", "draft", "rejected"].includes(p.sourcingPrimary)) {
    push(
      p.sourcingPrimary,
      p.sourcingPrimary.charAt(0).toUpperCase() + p.sourcingPrimary.slice(1),
      p.sourcingPrimary === "approved" ? "success" : p.sourcingPrimary === "rejected" ? "danger" : "neutral"
    );
  } else if (p.sourcingStatusRaw && sourcingTokens.length === 0) {
    push("sourcing-unknown", escLabel(p.sourcingStatusRaw), "muted");
  }

  if (sourcingTokens.includes("scaling") || set.has(String(p.id))) push("scaling", "Scaling", "accent");

  if (p.opsStatus === "active") push("active", "Active", "success");
  if (p.opsStatus === "removed") push("removed", "Removed", "muted");
  else if (p.opsStatus && p.opsStatus !== "active" && p.opsStatus !== "")
    push("ops-" + p.opsStatus, humanizeOps(p.opsStatus), "muted");

  return out;
}

function escLabel(s) {
  const t = String(s).replace(/[_]+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Unknown";
}

function humanizeOps(s) {
  return String(s)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function displaySupplier(p) {
  return p.supplierName || p.sourceName || "—";
}

export function skuLine(p) {
  const parts = [];
  if (p.sourceProductId) parts.push("Ext. " + p.sourceProductId);
  if (p.id) parts.push(String(p.id).slice(0, 8) + "…");
  return parts.length ? parts.join(" · ") : p.id ? String(p.id).slice(0, 8) + "…" : "—";
}

export function platformBadgeLabel(p) {
  const pl = (p.sourcePlatform || "").trim();
  if (!pl) return "";
  if (/manual/i.test(pl)) return "Manual";
  return pl.length > 22 ? pl.slice(0, 20) + "…" : pl;
}
