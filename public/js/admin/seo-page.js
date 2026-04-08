import { adminHeaders, esc, fmtTime } from "./utils.js";

function asMessage(v, fallback) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    if (typeof v.message === "string" && v.message.trim()) return v.message;
    if (typeof v.code === "string" && v.code.trim()) return v.code;
  }
  return fallback || "Ukendt fejl";
}

/** Gen-tjek SEO efter 15 dage (samme som server-side forventning). */
const SEO_RECHECK_MS = 15 * 24 * 60 * 60 * 1000;

const SEO_FIELD_DEFS = [
  { key: "name", label: "Produkttitel" },
  { key: "description", label: "Beskrivelse" },
  { key: "selling_points", label: "Salgspunkter" },
  { key: "seo_meta_title", label: "Meta-titel (Google)" },
  { key: "seo_meta_description", label: "Meta-beskrivelse (snippet)" },
];

function metaOk(p) {
  return String(p.seo_meta_title || "").trim().length >= 10;
}

/** Inden for 15 dage siden sidste scan og meta ser OK ud → grøn række, sorteres nederst. */
function seoFreshRow(p) {
  const iso = p.seo_last_checked_at;
  if (!iso || !metaOk(p)) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t < SEO_RECHECK_MS;
}

function needsSeoRecheck(p) {
  return !seoFreshRow(p);
}

function nextCheckLabel(p) {
  const iso = p.seo_last_checked_at;
  if (!iso) return "Aldrig scannet";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const due = t + SEO_RECHECK_MS;
  const left = due - Date.now();
  if (left <= 0) return "Tjek igen nu (" + fmtTime(iso) + ")";
  const days = Math.ceil(left / (24 * 60 * 60 * 1000));
  return "Igen om ca. " + days + " d. · senest " + fmtTime(iso);
}

function sortSeoRows(rows) {
  return [...rows].sort((a, b) => {
    const fa = seoFreshRow(a);
    const fb = seoFreshRow(b);
    if (fa !== fb) return fa ? 1 : -1;
    if (!fa && !fb) {
      const ta = a.seo_last_checked_at ? new Date(a.seo_last_checked_at).getTime() : 0;
      const tb = b.seo_last_checked_at ? new Date(b.seo_last_checked_at).getTime() : 0;
      if (ta === 0 && tb !== 0) return -1;
      if (tb === 0 && ta !== 0) return 1;
      return ta - tb;
    }
    return String(a.name || "").localeCompare(String(b.name || ""), "da");
  });
}

function snapshotFromSummaryRow(p) {
  return {
    name: String(p.name || ""),
    description: String(p.description || ""),
    selling_points: String(p.selling_points || ""),
    seo_meta_title: String(p.seo_meta_title || ""),
    seo_meta_description: String(p.seo_meta_description || ""),
  };
}

function openAdminModal(title, innerHtml) {
  const t = document.getElementById("modal-title");
  const b = document.getElementById("modal-body");
  const o = document.getElementById("modal-overlay");
  if (t) t.textContent = title;
  if (b) b.innerHTML = innerHtml;
  if (o) o.classList.add("open");
}

function renderSeoChangelogHtml(product, lastOptimization) {
  const hasDiff =
    lastOptimization &&
    lastOptimization.before &&
    lastOptimization.after &&
    typeof lastOptimization.before === "object" &&
    typeof lastOptimization.after === "object";

  let metaLine = "";
  if (product && product.seo_last_checked_at) {
    metaLine =
      '<p class="adm-seo-diff-meta hint-muted">Seneste SEO-scan i butikken: <strong>' +
      esc(fmtTime(product.seo_last_checked_at)) +
      "</strong></p>";
  }

  if (lastOptimization && lastOptimization.createdAt) {
    metaLine +=
      '<p class="adm-seo-diff-meta hint-muted">Logført ændring: <strong>' +
      esc(fmtTime(lastOptimization.createdAt)) +
      "</strong></p>";
  }

  if (lastOptimization && lastOptimization.note) {
    metaLine += '<p class="adm-seo-diff-note hint-muted">' + esc(lastOptimization.note) + "</p>";
  }

  if (!hasDiff) {
    const snap = product ? snapshotFromSummaryRow(product) : null;
    let body = "";
    if (snap) {
      body +=
        '<p class="hint-muted" style="margin-bottom:1rem">Der er ikke gemt et før/efter for denne vare endnu (ældre scan eller log). Her er de <strong>nuværende</strong> SEO-tekster i databasen:</p>';
      for (const { key, label } of SEO_FIELD_DEFS) {
        const val = snap[key] || "—";
        body +=
          '<div class="adm-seo-diff-block">' +
          '<h4 class="adm-seo-diff-block__label">' +
          esc(label) +
          "</h4>" +
          '<pre class="adm-seo-diff-pre adm-seo-diff-pre--single">' +
          esc(val) +
          "</pre></div>";
      }
    } else {
      body = "<p>Kunne ikke indlæse produktdata.</p>";
    }
    return metaLine + body;
  }

  const before = lastOptimization.before;
  const after = lastOptimization.after;
  let blocks = "";
  for (const { key, label } of SEO_FIELD_DEFS) {
    const b = String(before[key] ?? "");
    const a = String(after[key] ?? "");
    const changed = b !== a;
    blocks +=
      '<div class="adm-seo-diff-block' +
      (changed ? " adm-seo-diff-block--changed" : "") +
      '">' +
      '<h4 class="adm-seo-diff-block__label">' +
      esc(label) +
      (changed ? ' <span class="adm-seo-diff-badge">Ændret</span>' : "") +
      "</h4>" +
      '<div class="adm-seo-diff-pair">' +
      '<div class="adm-seo-diff-col"><span class="adm-seo-diff-tag">Før</span><pre class="adm-seo-diff-pre">' +
      esc(b || "—") +
      '</pre></div><div class="adm-seo-diff-col"><span class="adm-seo-diff-tag">Efter</span><pre class="adm-seo-diff-pre">' +
      esc(a || "—") +
      "</pre></div></div></div>";
  }

  return metaLine + blocks;
}

async function openSeoChangelog(productId) {
  if (!productId) return;
  openAdminModal("SEO · ændringer", "<p class=\"hint-muted\">Henter…</p>");
  try {
    const r = await fetch("/api/admin/products/" + encodeURIComponent(productId) + "/seo-changelog", {
      headers: adminHeaders({ json: false }),
      credentials: "include",
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) {
      const msg =
        (typeof j.error === "string" && j.error.trim()) ||
        (typeof j.message === "string" && j.message.trim()) ||
        asMessage(j.error, "Kunne ikke hente historik.");
      openAdminModal("SEO · ændringer", "<p>" + esc(msg) + "</p>");
      return;
    }
    const title = "SEO · " + (j.product && j.product.name ? String(j.product.name) : "produkt");
    openAdminModal(title, renderSeoChangelogHtml(j.product, j.lastOptimization));
  } catch {
    openAdminModal("SEO · ændringer", "<p>Netværksfejl.</p>");
  }
}

async function loadSeoList() {
  const status = document.getElementById("seo-page-status");
  const tbody = document.getElementById("seo-table-body");
  if (!tbody) return;
  if (status) status.textContent = "Henter produkter…";
  try {
    const r = await fetch("/api/admin/summary", { headers: adminHeaders({ json: false }) });
    const d = await r.json();
    if (!d.ok) {
      if (status) status.textContent = asMessage(d.error, "Kunne ikke hente liste");
      tbody.innerHTML = "";
      return;
    }
    const rows = sortSeoRows(
      (d.productCatalog || []).filter(
        (p) => p.status !== "removed" && String(p.sourcing_status || "").toLowerCase() === "approved"
      )
    );
    tbody.innerHTML = "";
    rows.forEach((p) => {
      const tr = document.createElement("tr");
      const ok = metaOk(p);
      const fresh = seoFreshRow(p);
      if (fresh) tr.classList.add("adm-seo-tr--fresh");
      const scanned = Boolean(p.seo_last_checked_at);
      const nameCell = scanned
        ? '<button type="button" class="adm-seo-product-open" data-id="' +
          esc(String(p.id)) +
          '" title="Se hvad SEO-scan har rettet">' +
          esc(p.name || "—") +
          "</button>"
        : esc(p.name || "—");
      tr.innerHTML =
        "<td>" +
        nameCell +
        "</td><td>" +
        (ok ? "Ja" : "—") +
        "</td><td>" +
        esc(nextCheckLabel(p)) +
        '</td><td><button type="button" class="adm-act-btn seo-run" data-id="' +
        esc(String(p.id)) +
        '">Scan &amp; opdatér</button></td>';
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll(".seo-run").forEach((btn) => {
      btn.addEventListener("click", () => runSeo(String(btn.getAttribute("data-id") || "").trim(), btn));
    });
    if (status) {
      const need = rows.filter(needsSeoRecheck).length;
      status.textContent =
        rows.length +
        " godkendte produkter — " +
        need +
        " skal have SEO-tjek (ingen scan, forældet over 15 d., eller manglende meta). Grøn = OK inden for 15 d. Klik på produktnavn efter et scan for at se før/efter.";
    }
  } catch {
    if (status) status.textContent = "Netværksfejl.";
    tbody.innerHTML = "";
  }
}

async function runSeo(id, btn) {
  const status = document.getElementById("seo-page-status");
  if (!id || !btn) return;
  btn.disabled = true;
  if (status) status.textContent = "Kører SEO-scan…";
  try {
    const r = await fetch("/api/admin/seo/run", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ productId: id }),
    });
    const text = await r.text();
    let j = {};
    if (text) {
      try {
        j = JSON.parse(text);
      } catch {
        j = { ok: false, error: text.slice(0, 200) };
      }
    }
    const payload = j && j.data && typeof j.data === "object" ? j.data : j;
    if (!payload.ok) {
      const msg = asMessage(payload.error || payload.message, "SEO-opdatering fejlede.");
      alert(msg);
      if (status) status.textContent = msg;
    } else {
      if (status) {
        status.textContent = payload.warning
          ? "Opdateret: " + (payload.product && payload.product.name) + " — " + payload.warning
          : "Opdateret: " + (payload.product && payload.product.name) + " — klik på navnet for at se før/efter.";
      }
      await loadSeoList();
    }
  } catch {
    alert("Netværksfejl.");
    if (status) status.textContent = "Netværksfejl.";
  } finally {
    btn.disabled = false;
  }
}

export function initSeoPage() {
  document.getElementById("seo-table-body")?.addEventListener("click", (e) => {
    const openBtn = e.target.closest(".adm-seo-product-open");
    if (openBtn) {
      e.preventDefault();
      const id = String(openBtn.getAttribute("data-id") || "").trim();
      if (id) openSeoChangelog(id);
    }
  });
  document.getElementById("seo-refresh")?.addEventListener("click", () => loadSeoList());
  document.querySelector('[data-page-tab="seo"]')?.addEventListener("click", () => {
    loadSeoList();
  });
  if (String(location.hash || "").replace(/^#/, "").trim() === "seo") {
    setTimeout(() => loadSeoList(), 0);
  }
}
