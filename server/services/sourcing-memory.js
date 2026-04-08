/**
 * Hukommelse når en vare fjernes via admin (Remove): undgå at sourcing/crawler
 * indsætter samme vare eller meget lignende titel fra samme leverandør igen.
 */

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "new",
  "one",
  "two",
  "med",
  "og",
  "til",
  "fra",
  "den",
  "det",
  "der",
  "som",
  "på",
  "af",
  "til",
  "size",
  "farve",
  "color",
]);

function supplierHost(url) {
  try {
    return new URL(String(url || "").trim())
      .hostname.replace(/^www\./i, "")
      .toLowerCase();
  } catch {
    return "";
  }
}

function canonicalUrl(u) {
  try {
    const x = new URL(String(u || "").trim());
    x.hash = "";
    x.search = "";
    let path = x.pathname || "";
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    x.pathname = path;
    return x.href.toLowerCase();
  } catch {
    return String(u || "")
      .trim()
      .toLowerCase()
      .split("?")[0]
      .split("#")[0]
      .replace(/\/+$/, "");
  }
}

function normalizeTitleForMatch(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9æøåäöüé\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(title) {
  return normalizeTitleForMatch(title)
    .split(" ")
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function tokenJaccard(tokensA, tokensB) {
  const A = new Set(tokensA);
  const B = new Set(tokensB);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

function jaccardThreshold() {
  const n = Number(process.env.SOURCING_REJECT_TITLE_JACCARD);
  if (Number.isFinite(n) && n > 0 && n <= 1) return n;
  return 0.45;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @returns {Promise<{ byExternalId: Set<string>, entries: Array<{ external_id: string, source_url: string, host: string, tokens: string[] }>, cooldown: Array<{ external_id: string, source_url: string, cooldown_until: string | null }> }>}
 */
async function loadSourcingUserRejects(supabase) {
  const empty = { byExternalId: new Set(), entries: [], cooldown: [] };
  if (!supabase) return empty;
  const limit = Math.min(800, Math.max(50, Number(process.env.SOURCING_REJECT_MEMORY_LIMIT) || 400));
  const { data, error } = await supabase
    .from("sourcing_user_rejects")
    .select("external_id, source_url, supplier_host, title_normalized")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) {
    if (error) {
      console.warn("[sourcing-memory] load rejects:", error.message || error);
    }
    return empty;
  }
  const byExternalId = new Set();
  const entries = [];
  for (const r of data) {
    const rowExt = String(r.external_id || "").trim();
    if (rowExt) byExternalId.add(rowExt);
    const surl = canonicalUrl(r.source_url || "");
    const host = String(r.supplier_host || "")
      .trim()
      .toLowerCase();
    entries.push({
      external_id: rowExt,
      source_url: surl,
      host,
      tokens: titleTokens(r.title_normalized || ""),
    });
  }
  let cooldown = [];
  try {
    const { data: coolRows } = await supabase
      .from("products")
      .select("external_id, source_url, cooldown_until")
      .not("cooldown_until", "is", null)
      .limit(limit);
    cooldown = coolRows || [];
  } catch {
    cooldown = [];
  }
  return { byExternalId, entries, cooldown };
}

/**
 * @param {object} raw — discovery-kandidat (title, sourceUrl, externalId, sourceProductId)
 * @param {{ byExternalId: Set<string>, entries: Array }} block
 */
function candidateBlockedByUserMemory(raw, block) {
  const candExt = String(raw.externalId || raw.sourceProductId || "").trim();
  const candUrl = canonicalUrl(raw.sourceUrl || "");
  const now = Date.now();
  for (const c of block.cooldown || []) {
    const cExp = c.cooldown_until ? new Date(c.cooldown_until).getTime() : 0;
    if (!cExp || cExp <= now) continue;
    const cExt = String(c.external_id || "").trim();
    const cUrl = canonicalUrl(c.source_url || "");
    if (
      (candExt && cExt && candExt === cExt) ||
      (candUrl && cUrl && (candUrl === cUrl || candUrl.startsWith(cUrl) || cUrl.startsWith(candUrl)))
    ) {
      return { blocked: true, reason: "cooldown_active", cooldown_until: c.cooldown_until };
    }
  }

  if (candExt && block.byExternalId.has(candExt)) {
    return { blocked: true, reason: "external_id" };
  }

  const host = supplierHost(raw.sourceUrl || "");
  const candTokens = titleTokens(raw.title || "");
  const thr = jaccardThreshold();

  for (const e of block.entries) {
    if (e.external_id && candExt && e.external_id === candExt) {
      return { blocked: true, reason: "external_id" };
    }
    if (
      candUrl &&
      e.source_url &&
      (candUrl === e.source_url || candUrl.startsWith(e.source_url) || e.source_url.startsWith(candUrl))
    ) {
      return { blocked: true, reason: "source_url" };
    }
    if (host && e.host && host === e.host && candTokens.length && e.tokens.length) {
      const j = tokenJaccard(candTokens, e.tokens);
      if (j >= thr) {
        return { blocked: true, reason: "similar_title_same_supplier", similarity: Math.round(j * 100) };
      }
    }
  }
  return { blocked: false };
}

/**
 * Kald når brugeren fjerner en vare fra shop (status removed).
 * @param {object} product — række med name, external_id, source_url, source_product_id
 */
async function recordUserRemovedProduct(supabase, product) {
  if (!supabase || !product) return { ok: false };
  const surl = String(product.source_url || "").trim();
  const ext = String(product.external_id || product.source_product_id || "").trim();
  const host = supplierHost(surl);
  const title = String(product.name || "").slice(0, 500);
  try {
    const { error } = await supabase.from("sourcing_user_rejects").insert({
      external_id: ext,
      source_url: surl,
      supplier_host: host,
      title_normalized: title,
    });
    if (error) {
      if (error.code === "42P01" || /relation|does not exist/i.test(String(error.message || ""))) {
        console.warn("[sourcing-memory] sourcing_user_rejects table missing — run migrate_sourcing_user_rejects.sql");
        return { ok: false, skipped: true };
      }
      console.warn("[sourcing-memory] insert reject:", error.message || error);
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.warn("[sourcing-memory]", e);
    return { ok: false };
  }
}

/**
 * Kald når bruger svarer "nej" i sourcing-chatten.
 * Samme memory-tabel som admin-remove, så kandidaten ikke vises igen.
 */
async function recordUserRejectedSourcingCandidate(supabase, candidate) {
  if (!supabase || !candidate) return { ok: false };
  const sourceUrl = String(candidate.sourceUrl || "").trim();
  const externalId = String(candidate.sourceProductId || candidate.externalId || "").trim();
  const host = supplierHost(sourceUrl);
  const title = String(candidate.name || candidate.title || "").slice(0, 500);
  try {
    const { error } = await supabase.from("sourcing_user_rejects").insert({
      external_id: externalId,
      source_url: sourceUrl,
      supplier_host: host,
      title_normalized: title,
    });
    if (error) {
      if (error.code === "42P01" || /relation|does not exist/i.test(String(error.message || ""))) {
        console.warn("[sourcing-memory] sourcing_user_rejects table missing — run migrate_sourcing_user_rejects.sql");
        return { ok: false, skipped: true };
      }
      console.warn("[sourcing-memory] insert chat reject:", error.message || error);
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.warn("[sourcing-memory]", e);
    return { ok: false };
  }
}

/** Nulstil hukommelse ved ny butikstype/niche. */
async function clearSourcingUserRejects(supabase) {
  if (!supabase) return { ok: false };
  try {
    const { error } = await supabase.from("sourcing_user_rejects").delete().not("id", "is", null);
    if (error) {
      if (error.code === "42P01" || /relation|does not exist/i.test(String(error.message || ""))) {
        return { ok: false, skipped: true };
      }
      console.warn("[sourcing-memory] clear rejects:", error.message || error);
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.warn("[sourcing-memory]", e);
    return { ok: false };
  }
}

module.exports = {
  loadSourcingUserRejects,
  candidateBlockedByUserMemory,
  recordUserRemovedProduct,
  recordUserRejectedSourcingCandidate,
  clearSourcingUserRejects,
  supplierHost,
};
