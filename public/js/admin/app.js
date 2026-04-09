/**
 * Velden admin dashboard — data load + wiring.
 *
 * Component map (presentation vs. files):
 * - AdminLayout / tabs: `admin.html` (`.adm-wrap`, `.adm-page`)
 * - AdminHeader + engine strip: `render.renderCommandCenter`
 * - MetricCard grid: `render.renderKpiGrid`
 * - ActionLogPanel: `render.renderLog`
 * - FilterBar: `admin.html` + filter listeners here
 * - CatalogueTable: `render.renderCatalogRows`
 * - StatusBadges: `status-model.buildStatusDescriptors` + `render.statusBadgesHtml`
 * - OriginCell / product cell / actions: `render.originCellHtml` + row template in `render.renderCatalogRows`
 * - RecentAiWorkPanel: `render.renderPlanPanel`
 * - LiveSourcingPanel: `sourcing-chat.js`
 */
import { adminHeaders, esc, fmtTime } from "./utils.js";
import { normalizeProductRow, hasCompleteSource } from "./status-model.js";
import {
  renderLog,
  renderCommandCenter,
  renderKpiGrid,
  renderPlanPanel,
  renderCatalogRows,
  renderAttention,
  renderAdminActionFeedback,
} from "./render.js";
import {
  wireSourcingChat,
} from "./sourcing-chat.js";
import { initBotAssistant } from "./bot-assistant.js";
import { initSeoPage } from "./seo-page.js";

/** Fuld katalog / log / KPI fra serveren */
const FULL_REFRESH_MS = 20000;
/** Kun motorstatus (billigt — ingen DB) */
const PULSE_MS = 4000;
const FULFILLMENT_PANEL_REFRESH_MS = 15000;
const panelErr = document.getElementById("err-banner");

let catalogNormalized = [];
let scaleIdSet = new Set();
/** Seneste vellykkede summary — pulsen merger `ai` ind i denne */
let lastSnapshot = null;
let currentStoreConfig = null;
let hasLoadedSummary = false;
let lastAiFeedRows = [];
let selectedSourcingRunId = null;
let aiFaceBubbleTimer = null;
let trashViewEnabled = false;
let summaryLoadInFlight = false;
let summaryReloadQueued = false;
const apiClient = (window.VeldenApiClient && window.VeldenApiClient.request) || null;
const reportUnauthorized =
  (typeof window !== "undefined" && window.VeldenUnauthorized && window.VeldenUnauthorized.report) ||
  function (msg) {
    const panelErr = document.getElementById("err-banner");
    if (!panelErr) return;
    panelErr.textContent =
      (msg && String(msg).trim()) ||
      "Unauthorized. Admin session er udloeber/mangler. Udfyld admin secret igen og refresh.";
    panelErr.style.display = "block";
  };
const noteAdminHttpOk =
  (typeof window !== "undefined" && window.VeldenUnauthorized && window.VeldenUnauthorized.noteResponseOk) ||
  function () {};

function setUnauthorizedState(message) {
  reportUnauthorized(message);
}

function adminApiFailureText(data, fallback) {
  const d = data || {};
  if (typeof d.message === "string" && d.message.trim()) return d.message.trim();
  if (typeof d.error === "string" && d.error.trim()) return d.error.trim();
  return fallback || "Unauthorized";
}

async function apiRequest(url, options) {
  const opts = Object.assign({ credentials: "include", cache: "no-store" }, options || {});
  if (apiClient) {
    const r = await apiClient(url, opts);
    if (r.status === 401) {
      const data = r.data || {};
      reportUnauthorized(adminApiFailureText(data, r.message || "Unauthorized"));
    } else if (r.response && r.response.ok) {
      noteAdminHttpOk(true);
    }
    return {
      ok: r.ok,
      status: r.status,
      data: r.data,
      message: r.message,
    };
  }
  try {
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) {
      reportUnauthorized(adminApiFailureText(data, "Unauthorized"));
    } else if (r.ok) {
      noteAdminHttpOk(true);
    }
    return { ok: r.ok && (data.ok !== false), status: r.status, data, message: data.message || data.error };
  } catch (err) {
    return { ok: false, status: 0, data: null, message: err && err.message ? err.message : "Netværksfejl" };
  }
}

function goToCatalogAndFocusSecret() {
  document.querySelector('[data-page-tab="catalog"]')?.click();
  setTimeout(() => {
    document.getElementById("catalog-table")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 80);
}

function flashAdminAuthBannerError(message) {
  renderAdminActionFeedback(message || "Unauthorized.", "error");
}

function buildScaleIdSet(ai) {
  const plan = ai && ai.lastPlan;
  if (!plan) return new Set();
  const ids = plan.scaleProductIds || plan.scaleIds || [];
  return new Set((ids || []).map((x) => String(x)));
}

function fillFilterOptions(rows) {
  const plSet = {};
  const cSet = {};
  const iSet = {};
  rows.forEach((p) => {
    if (p.sourcePlatform) plSet[p.sourcePlatform] = 1;
    if (p.supplierCountry) cSet[p.supplierCountry] = 1;
    if (p.importMethod) iSet[p.importMethod] = 1;
  });
  function refill(id, keys) {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    keys.sort().forEach((v) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    });
    if (keys.indexOf(cur) >= 0) sel.value = cur;
  }
  refill("f-platform", Object.keys(plSet));
  refill("f-country", Object.keys(cSet));
  refill("f-import", Object.keys(iSet));
}

function filterRows(rows) {
  const q = document.getElementById("f-search")?.value.trim().toLowerCase() || "";
  const st = document.getElementById("f-status")?.value || "";
  const pl = document.getElementById("f-platform")?.value || "";
  const co = document.getElementById("f-country")?.value || "";
  const im = document.getElementById("f-import")?.value || "";
  const smin = document.getElementById("f-smin")?.value || "";
  const smax = document.getElementById("f-smax")?.value || "";

  return rows.filter((p) => {
    if (!trashViewEnabled && p.opsStatus === "removed") return false;
    if (trashViewEnabled && p.opsStatus !== "removed") return false;
    if (q && (p.name || "").toLowerCase().indexOf(q) < 0 && (p.title || "").toLowerCase().indexOf(q) < 0)
      return false;
    if (st === "missing-source") {
      if (hasCompleteSource(p)) return false;
    } else if (st === "removed") {
      if (p.opsStatus !== "removed") return false;
    } else if (st) {
      if (p.sourcingPrimary !== st) return false;
    }
    if (pl && p.sourcePlatform !== pl) return false;
    if (co && p.supplierCountry !== co) return false;
    if (im && p.importMethod !== im) return false;
    if (smin !== "") {
      if (p.aiScore == null || p.aiScore === "") return false;
      if (Number(p.aiScore) < Number(smin)) return false;
    }
    if (smax !== "") {
      if (p.aiScore == null || p.aiScore === "") return false;
      if (Number(p.aiScore) > Number(smax)) return false;
    }
    return true;
  });
}

function applyFilterAndScroll(attnValue) {
  const fs = document.getElementById("f-status");
  if (fs) fs.value = attnValue || "";
  applyFiltersAndRender();
  document.getElementById("catalog-table")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function syncTrashToggleUi() {
  const btn = document.getElementById("btn-trash-toggle");
  if (!btn) return;
  btn.setAttribute("aria-pressed", trashViewEnabled ? "true" : "false");
  btn.textContent = trashViewEnabled ? "Papirkurv (åben)" : "Papirkurv";
}

function wireRowActions(tbody) {
  tbody.querySelectorAll("[data-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.getAttribute("data-modal");
      const id = btn.getAttribute("data-id");
      const p = catalogNormalized.find((x) => x.id === id);
      if (!p) return;
      if (kind === "reason") {
        const txt = p.brandFitReason || "No AI fit rationale stored for this SKU.";
        openModal("AI brand fit", "<p>" + esc(txt).replace(/\n/g, "<br/>") + "</p>");
      }
      if (kind === "meta") {
        const json = JSON.stringify(p._raw, null, 2);
        openModal("Raw metadata", "<pre>" + esc(json) + "</pre>");
      }
    });
  });
  tbody.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const url = btn.getAttribute("data-copy");
      if (!url) return;
      navigator.clipboard.writeText(url).then(
        () => {},
        () => {}
      );
    });
  });
  tbody.querySelectorAll("[data-approve-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = String(btn.getAttribute("data-approve-id") || "").trim();
      if (!id) return;
      if (!confirm("Godkende dette produkt til webshopen? (sourcing → approved)")) return;
      const prev = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Gemmer...";
      renderAdminActionFeedback("Godkender produkt...", "info");
      const x = await apiRequest("/api/admin/products/" + encodeURIComponent(id), {
        method: "PATCH",
        headers: adminHeaders(),
        body: JSON.stringify({ sourcing_status: "approved" }),
      });
      btn.disabled = false;
      btn.textContent = prev;
      if (x.ok && x.data && x.data.ok) {
        const fs = document.getElementById("f-status");
        if (fs && fs.value === "draft") fs.value = "";
        renderAdminActionFeedback("Produkt godkendt. This confirms the product as a good fit.", "info");
        load();
      } else if (x.status === 401) {
        flashAdminAuthBannerError(
          "Godkend blev afvist (401). Udfyld X-Admin-Secret med samme værdi som ADMIN_SECRET på serveren."
        );
        goToCatalogAndFocusSecret();
      } else {
        renderAdminActionFeedback(
          (x.data && (x.data.message || x.data.error)) ||
            "Kunne ikke godkende — tjek at produktet findes og ikke allerede er fjernet.",
          "error"
        );
      }
    });
  });
  tbody.querySelectorAll("[data-delete-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = String(btn.getAttribute("data-delete-id") || "").trim();
      if (!id) return;
      if (!confirm("Fjern produktet fra butikken? (status sættes til removed)")) return;
      const prev = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Fjerner...";
      renderAdminActionFeedback("Fjerner produkt...", "info");
      const x = await apiRequest("/api/admin/products/" + encodeURIComponent(id) + "/remove", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({}),
      });
      btn.disabled = false;
      btn.textContent = prev;
      if (x.ok && x.data && x.data.ok) {
        renderAdminActionFeedback("Produkt fjernet. This helps AI avoid similar products in the future.", "info");
        load();
      } else if (x.status === 401) {
        try {
          sessionStorage.removeItem("velden_admin_secret");
          localStorage.removeItem("velden_admin_secret");
        } catch {
          /* ignore */
        }
        const caEl = document.getElementById("catalog-admin-secret");
        const scEl = document.getElementById("sourcing-chat-admin-secret");
        const hdEl = document.getElementById("header-admin-secret");
        if (caEl) caEl.value = "";
        if (scEl) scEl.value = "";
        if (hdEl) hdEl.value = "";
        flashAdminAuthBannerError(
          "401: Forkert eller manglende X-Admin-Secret. Genstart server efter ændring i .env, og indtast præcis den samme streng som ADMIN_SECRET (ingen mellemrum før/efter)."
        );
        goToCatalogAndFocusSecret();
      } else {
        renderAdminActionFeedback(
          (x.data && (x.data.message || x.data.error)) ||
            "Kunne ikke slette (produktet findes måske ikke eller er allerede fjernet).",
          "error"
        );
      }
    });
  });
  tbody.querySelectorAll("[data-restore-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = String(btn.getAttribute("data-restore-id") || "").trim();
      if (!id) return;
      if (!confirm("Gendan produktet fra papirkurven til kataloget?")) return;
      const prev = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Gendanner...";
      renderAdminActionFeedback("Gendanner produkt...", "info");
      const x = await apiRequest("/api/admin/products/" + encodeURIComponent(id) + "/restore", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({}),
      });
      btn.disabled = false;
      btn.textContent = prev;
      if (x.ok && x.data && x.data.ok) {
        renderAdminActionFeedback("Produkt gendannet fra papirkurv.", "info");
        load();
      } else {
        renderAdminActionFeedback(
          (x.data && (x.data.message || x.data.error)) || "Kunne ikke gendanne produkt.",
          "error"
        );
      }
    });
  });
  tbody.querySelectorAll("[data-optimize-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = String(btn.getAttribute("data-optimize-id") || "").trim();
      if (!id) return;
      const prev = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Optimizing...";
      renderAdminActionFeedback("Kører AI-optimering...", "info");
      const x = await apiRequest("/api/admin/products/" + encodeURIComponent(id) + "/seo-optimize", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({}),
      });
      btn.disabled = false;
      btn.textContent = prev;
      if (x.ok && x.data && x.data.ok) {
        renderAdminActionFeedback("AI-optimering kørt for produkt.", "info");
      } else {
        renderAdminActionFeedback((x.data && (x.data.message || x.data.error)) || "Kunne ikke optimere.", "error");
      }
    });
  });
}

function openModal(title, innerHtml) {
  const t = document.getElementById("modal-title");
  const b = document.getElementById("modal-body");
  const o = document.getElementById("modal-overlay");
  if (t) t.textContent = title;
  if (b) b.innerHTML = innerHtml;
  if (o) o.classList.add("open");
}

function closeModal() {
  document.getElementById("modal-overlay")?.classList.remove("open");
}

function applyFiltersAndRender() {
  const filtered = filterRows(catalogNormalized);
  if (!filtered.length && !trashViewEnabled) {
    // Safety fallback: if filters/logic temporarily zero out rows, still show non-removed products.
    const nonRemoved = catalogNormalized.filter((p) => p && p.opsStatus !== "removed");
    if (nonRemoved.length) {
      renderCatalogRows(nonRemoved, catalogNormalized, scaleIdSet, wireRowActions);
      return;
    }
  }
  renderCatalogRows(filtered, catalogNormalized, scaleIdSet, wireRowActions);
}

function fmtMoneyCents(cents, currency) {
  const amount = (Number(cents) || 0) / 100;
  const c = String(currency || "usd").toUpperCase();
  try {
    return new Intl.NumberFormat("da-DK", { style: "currency", currency: c }).format(amount);
  } catch {
    return amount.toFixed(2) + " " + c;
  }
}

function fulfillmentBadge(status) {
  const s = String(status || "").toLowerCase();
  if (s === "submitted" || s === "accepted") return '<span class="adm-status approved">Submitted</span>';
  if (s === "manual_required") return '<span class="adm-status removed">Manual</span>';
  if (s === "failed") return '<span class="adm-status rejected">Failed</span>';
  return '<span class="adm-status draft">Pending</span>';
}

function renderFulfillmentRows(rows) {
  const body = document.getElementById("fulfillment-body");
  if (!body) return;
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    body.innerHTML =
      '<tr><td colspan="6"><p class="hint-muted" style="margin:.5rem 0;">Ingen ordrer endnu.</p></td></tr>';
    return;
  }
  body.innerHTML = list
    .map((o) => {
      const f = (o && o.fulfillment) || {};
      const runs = Array.isArray(f.runs) ? f.runs : [];
      const details = runs.length
        ? runs
            .map((r) => {
              const ref = r.reference ? " #" + esc(String(r.reference)) : "";
              return esc(String(r.platform || "unknown")) + ": " + esc(String(r.status || "pending")) + ref;
            })
            .join(" · ")
        : f.lastError
          ? esc(String(f.lastError))
          : "—";
      const lastAt = f.updatedAt || f.lastAttemptAt || o.createdAt || "";
      return (
        "<tr>" +
        "<td><code>" +
        esc(String(o.id || "").slice(0, 8)) +
        "</code></td>" +
        "<td>" +
        esc(o.customerEmail || "—") +
        "</td>" +
        '<td class="text-end">' +
        esc(fmtMoneyCents(o.amountCents, o.currency)) +
        "</td>" +
        "<td>" +
        fulfillmentBadge(f.status || "pending") +
        "</td>" +
        "<td>" +
        esc(fmtTime(lastAt)) +
        "</td>" +
        '<td class="hint-muted" style="max-width:28ch;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' +
        esc(details) +
        '">' +
        details +
        "</td>" +
        "</tr>"
      );
    })
    .join("");
}

async function refreshFulfillmentPanel() {
  const body = document.getElementById("fulfillment-body");
  if (!body) return;
  const r = await apiRequest("/api/admin/orders/fulfillment", { headers: adminHeaders({ json: false }) });
  if (!r.ok) {
    body.innerHTML =
      '<tr><td colspan="6"><p class="hint-muted" style="margin:.5rem 0;">Kunne ikke hente fulfillment-status.</p></td></tr>';
    return;
  }
  renderFulfillmentRows((r.data && r.data.orders) || []);
}

const FULFILLMENT_INBOX_REFRESH_MS = 15000;
let fulfillmentInboxRefreshTimer = null;
/** @type {Map<string, object>} */
const fulfillmentInboxItemById = new Map();

function showFulfillmentInboxToast(message, kind) {
  const el = document.getElementById("fulfillment-inbox-toast");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  el.classList.remove("is-error", "is-ok");
  el.classList.add(kind === "error" ? "is-error" : "is-ok");
  clearTimeout(el._hideT);
  el._hideT = setTimeout(() => {
    el.hidden = true;
    el.textContent = "";
  }, 4500);
}

function catalogProductByIdForInbox(pid) {
  const sid = String(pid || "");
  if (!sid || !catalogNormalized.length) return null;
  return catalogNormalized.find((p) => String(p.id) === sid) || null;
}

function buildEbayAutofillPayload(item) {
  const vd = item.variant_data && typeof item.variant_data === "object" ? item.variant_data : {};
  const cd = item.customer_data && typeof item.customer_data === "object" ? item.customer_data : {};
  const payload = {
    name: cd.fullName || cd.name || "",
    addressLine1: cd.addressLine1 || "",
    city: cd.city || "",
    postalCode: cd.postalCode || "",
    country: cd.country || cd.shippingCountry || "",
    size: vd.size || "",
    color: vd.color || "",
  };
  Object.keys(payload).forEach((k) => {
    if (payload[k] === "" || payload[k] == null) delete payload[k];
  });
  return payload;
}

function encodeVeldenDataBase64Url(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return b64;
}

function appendVeldenDataToSupplierUrl(url, payload) {
  if (!payload || typeof payload !== "object" || !Object.keys(payload).length) return url;
  const veldenData = encodeVeldenDataBase64Url(payload);
  try {
    const u = new URL(url);
    u.searchParams.set("velden_data", veldenData);
    return u.toString();
  } catch {
    const sep = url.indexOf("?") >= 0 ? "&" : "?";
    return url + sep + "velden_data=" + encodeURIComponent(veldenData);
  }
}

function formatFulfillmentInboxCopy(item) {
  const vd = item.variant_data && typeof item.variant_data === "object" ? item.variant_data : {};
  const cd = item.customer_data && typeof item.customer_data === "object" ? item.customer_data : {};
  const variantBits = [vd.size, vd.color].filter(Boolean);
  const variantLabel = variantBits.length ? variantBits.join(" · ") : "—";
  const lines = [
    "Order ID: " + String(item.order_id || "—"),
    "Queue ID: " + String(item.id || "—"),
    "Product: " + String(vd.title || "—"),
    "Quantity: " + String(vd.quantity != null ? vd.quantity : 1),
    "Variant: " + variantLabel,
    "",
    "Customer",
    "Name: " + String(cd.fullName || cd.name || "—"),
    "Email: " + String(cd.email || "—"),
    "Phone: " + String(cd.phone || "—"),
    "Address: " + String(cd.addressLine1 || "—"),
    "Postal: " + String(cd.postalCode || "—"),
    "City: " + String(cd.city || "—"),
    "Country: " + String(cd.country || "—"),
    "Shipping country: " + String(cd.shippingCountry || "—"),
  ];
  return lines.join("\n");
}

async function copyTextToClipboardFulfillment(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function setFulfillmentInboxCardBusy(cardEl, busy) {
  if (!cardEl) return;
  cardEl.querySelectorAll("[data-fq-buy],[data-fq-complete]").forEach((btn) => {
    btn.disabled = Boolean(busy);
  });
}

function renderFulfillmentInboxSkeleton() {
  const list = document.getElementById("fulfillment-inbox-list");
  if (!list) return;
  list.innerHTML =
    '<div class="adm-inbox-skeleton" aria-hidden="true"></div><div class="adm-inbox-skeleton" aria-hidden="true"></div>';
}

function renderFulfillmentInboxItems(items) {
  const list = document.getElementById("fulfillment-inbox-list");
  if (!list) return;
  const arr = Array.isArray(items) ? items : [];
  fulfillmentInboxItemById.clear();
  arr.forEach((it) => {
    if (it && it.id != null) fulfillmentInboxItemById.set(String(it.id), it);
  });
  if (!arr.length) {
    list.innerHTML = '<div class="adm-inbox-empty">No pending orders.</div>';
    return;
  }
  list.innerHTML = arr
    .map((item) => {
      const cat = catalogProductByIdForInbox(item.product_id);
      const vd = item.variant_data && typeof item.variant_data === "object" ? item.variant_data : {};
      const cd = item.customer_data && typeof item.customer_data === "object" ? item.customer_data : {};
      const title = String(vd.title || (cat && cat.name) || "Product");
      const imgUrl = cat && cat.image ? String(cat.image).trim() : "";
      const vParts = [vd.size, vd.color].filter(Boolean);
      const variantStr = vParts.length ? vParts.join(" · ") : "—";
      const custName = String(cd.fullName || cd.name || "—");
      const addrParts = [cd.addressLine1, [cd.postalCode, cd.city].filter(Boolean).join(" "), cd.country].filter(
        Boolean
      );
      const addrStr = addrParts.length ? addrParts.join("\n") : "—";
      const url = String(item.supplier_url || "").trim();
      const urlSafe = /^https?:\/\//i.test(url);
      const price = cat && cat.price != null ? Number(cat.price) : null;
      const highValue = price != null && !Number.isNaN(price) && price >= 1500;
      const cardClass = "adm-inbox-card" + (highValue ? " adm-inbox-card--value" : "");
      const imgBlock = imgUrl
        ? '<div class="adm-inbox-card__media"><img src="' + esc(imgUrl) + '" alt="" loading="lazy" /></div>'
        : '<div class="adm-inbox-card__media"><div class="adm-inbox-card__placeholder">No image</div></div>';
      const idAttr = esc(String(item.id));
      const band = String(item.priority_band || "low").toLowerCase();
      const prScore = item.priority_score != null ? Number(item.priority_score) : 0;
      const prReasons = Array.isArray(item.priority_reasons) ? item.priority_reasons : [];
      const tooltipParts = [
        "Priority score: " + (Number.isFinite(prScore) ? prScore.toFixed(1) : "0"),
        ...prReasons,
      ];
      const tooltip = tooltipParts.join(" · ");
      let priorityBadge =
        '<span class="adm-inbox-priority adm-inbox-priority--low" title="' +
        esc(tooltip) +
        '">🧊 Low</span>';
      if (band === "high") {
        priorityBadge =
          '<span class="adm-inbox-priority adm-inbox-priority--high" title="' +
          esc(tooltip) +
          '">🔥 High Priority</span>';
      } else if (band === "medium") {
        priorityBadge =
          '<span class="adm-inbox-priority adm-inbox-priority--medium" title="' +
          esc(tooltip) +
          '">⚠️ Medium</span>';
      }
      return (
        '<article class="' +
        esc(cardClass) +
        '" data-fq-card-id="' +
        idAttr +
        '">' +
        imgBlock +
        '<div class="adm-inbox-card__body">' +
        '<div class="adm-inbox-card__top">' +
        '<h3 class="adm-inbox-card__title">' +
        esc(title) +
        '</h3><div class="adm-inbox-badges">' +
        priorityBadge +
        '<span class="adm-inbox-badge">Pending</span></div></div>' +
        '<div class="adm-inbox-card__grid">' +
        '<div><div class="adm-inbox-card__label">Variant</div><div>' +
        esc(variantStr) +
        '</div></div>' +
        '<div><div class="adm-inbox-card__label">Qty</div><div>' +
        esc(String(vd.quantity != null ? vd.quantity : 1)) +
        '</div></div>' +
        '<div><div class="adm-inbox-card__label">Customer</div><div>' +
        esc(custName) +
        '</div></div>' +
        '<div><div class="adm-inbox-card__label">Address</div><div style="white-space:pre-line">' +
        esc(addrStr) +
        '</div></div>' +
        '<div style="grid-column:1/-1"><div class="adm-inbox-card__label">Supplier</div>' +
        (urlSafe
          ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + "</a>"
          : '<span class="hint-muted">' + esc(url || "—") + "</span>") +
        "</div></div>" +
        '<div class="adm-inbox-card__actions">' +
        '<button type="button" class="adm-btn-ghost adm-btn-primary" data-fq-buy data-fq-id="' +
        idAttr +
        '">Buy on eBay</button>' +
        '<button type="button" class="adm-btn-ghost" data-fq-complete data-fq-id="' +
        idAttr +
        '">Mark as completed</button>' +
        "</div></div></article>"
      );
    })
    .join("");
}

async function refreshFulfillmentInbox(showLoading) {
  const list = document.getElementById("fulfillment-inbox-list");
  const meta = document.getElementById("fulfillment-inbox-meta");
  if (!list) return;
  if (showLoading) renderFulfillmentInboxSkeleton();
  const r = await apiRequest("/api/admin/fulfillment-queue?status=pending", {
    headers: adminHeaders({ json: false }),
  });
  const now = new Date();
  if (meta) {
    meta.textContent =
      "Last updated " +
      now.toLocaleTimeString(undefined, { timeStyle: "short" }) +
      " · Auto-refresh every " +
      Math.round(FULFILLMENT_INBOX_REFRESH_MS / 1000) +
      "s";
  }
  if (!r.ok) {
    list.innerHTML =
      '<div class="adm-inbox-empty">Could not load inbox. Check connection and admin access.</div>';
    showFulfillmentInboxToast(String(r.message || "Failed to load fulfillment inbox"), "error");
    return;
  }
  const items = (r.data && r.data.items) || [];
  renderFulfillmentInboxItems(items);
}

function startFulfillmentInboxAutoRefresh() {
  if (fulfillmentInboxRefreshTimer) clearInterval(fulfillmentInboxRefreshTimer);
  fulfillmentInboxRefreshTimer = setInterval(() => {
    refreshFulfillmentInbox(false).catch(() => {});
  }, FULFILLMENT_INBOX_REFRESH_MS);
}

function wireFulfillmentInboxList() {
  const list = document.getElementById("fulfillment-inbox-list");
  if (!list || list.dataset.inboxWired === "1") return;
  list.dataset.inboxWired = "1";
  list.addEventListener("click", async (ev) => {
    const buyBtn = ev.target && ev.target.closest ? ev.target.closest("[data-fq-buy]") : null;
    const doneBtn = ev.target && ev.target.closest ? ev.target.closest("[data-fq-complete]") : null;
    if (!buyBtn && !doneBtn) return;
    const btn = buyBtn || doneBtn;
    const id = btn.getAttribute("data-fq-id");
    if (!id) return;
    const card = btn.closest("article.adm-inbox-card");
    const item = fulfillmentInboxItemById.get(String(id));

    if (buyBtn) {
      if (!item) {
        showFulfillmentInboxToast("Item data missing — refresh the page.", "error");
        return;
      }
      setFulfillmentInboxCardBusy(card, true);
      const text = formatFulfillmentInboxCopy(item);
      const copied = await copyTextToClipboardFulfillment(text);
      setFulfillmentInboxCardBusy(card, false);
      if (!copied) {
        showFulfillmentInboxToast("Could not copy to clipboard.", "error");
        return;
      }
      showFulfillmentInboxToast("Details copied to clipboard.", "ok");
      const url = String(item.supplier_url || "").trim();
      if (!/^https?:\/\//i.test(url)) {
        showFulfillmentInboxToast("No valid supplier URL to open.", "error");
        return;
      }
      const payload = buildEbayAutofillPayload(item);
      const openUrl = appendVeldenDataToSupplierUrl(url, payload);
      window.open(openUrl, "_blank", "noopener,noreferrer");
      return;
    }

    if (doneBtn) {
      setFulfillmentInboxCardBusy(card, true);
      const x = await apiRequest("/api/admin/fulfillment-queue/" + encodeURIComponent(id) + "/complete", {
        method: "POST",
        headers: adminHeaders(),
        body: "{}",
      });
      setFulfillmentInboxCardBusy(card, false);
      if (!x.ok) {
        showFulfillmentInboxToast(String((x.data && (x.data.error || x.data.message)) || x.message || "Complete failed"), "error");
        return;
      }
      showFulfillmentInboxToast("Marked as completed.", "ok");
      fulfillmentInboxItemById.delete(String(id));
      if (card && card.parentNode) card.remove();
      if (!list.querySelector("article.adm-inbox-card")) {
        list.innerHTML = '<div class="adm-inbox-empty">No pending orders.</div>';
      }
    }
  });
}

function renderFullSummary(data) {
  const unauthorized =
    typeof window !== "undefined" && window.VeldenUnauthorized && window.VeldenUnauthorized.expired;
  if (panelErr && !unauthorized) panelErr.style.display = "none";
  if (!data.ok) {
    if (panelErr) {
      panelErr.textContent = data.error || "Could not load summary.";
      panelErr.style.display = "block";
    }
    refreshFulfillmentInbox(false).catch(() => {});
    refreshFulfillmentPanel().catch(() => {});
    return;
  }

  const ai = data.ai || {};
  scaleIdSet = buildScaleIdSet(ai);

  renderCommandCenter(ai, data, PULSE_MS, FULL_REFRESH_MS);
  renderKpiGrid(ai, data);
  renderTopStatus(ai);
  renderInsights(data, ai);
  renderTrendCharts(data);
  renderSinceLastVisit(data);

  const rawCat = data.productCatalog || [];
  catalogNormalized = rawCat.map(normalizeProductRow).filter(Boolean);
  renderAttention(catalogNormalized, applyFilterAndScroll);
  fillFilterOptions(catalogNormalized);
  applyFiltersAndRender();

  const feed = data.logFeed || [];
  renderLog(feed);
  renderAiActivityFeed(feed);
  const logHint = document.getElementById("log-section-hint");
  if (logHint) {
    logHint.textContent = feed.length
      ? feed.length + " events · newest first · between automation passes"
      : "No events yet — entries appear after each pass.";
  }

  refreshSourcingRunsPanel().catch(() => {});
  refreshSourcingCandidates().catch(() => {});
  refreshFulfillmentPanel().catch(() => {});
  refreshFulfillmentInbox(false).catch(() => {});

  renderPlanPanel(ai);
  updateCeoOpsUi(ai);
}

function renderTopStatus(ai) {
  const statusEl = document.getElementById("cc-ai-status");
  const runEl = document.getElementById("cc-last-run");
  const decisionEl = document.getElementById("cc-last-decision");
  const isPaused = Boolean(ai && ai.ceoPaused);
  const lastErrorText = String((ai && ai.lastError) || "");
  const isPauseSafetyNote =
    /safety kill-switch triggered:\s*automation paused\.?/i.test(lastErrorText) ||
    /automation paused/i.test(lastErrorText);
  const hasError = Boolean(lastErrorText) && !isPauseSafetyNote;
  const isRunning = Boolean(ai && ai.running);
  const isSourcing = Boolean(ai && ai.sourcingRunning);
  if (statusEl) {
    if (isPaused) statusEl.textContent = "Paused";
    else if (hasError) statusEl.textContent = "Error";
    else if (isRunning) statusEl.textContent = "Running";
    else statusEl.textContent = "Standby";
  }
  const desc = document.getElementById("cc-ai-status-desc");
  if (desc) {
    if (isPaused) desc.textContent = "Automation is paused";
    else if (hasError) desc.textContent = "Action needed: check AI log";
    else if (isRunning) desc.textContent = "Optimizing products";
    else if (isSourcing) desc.textContent = "Evaluating new products";
    else desc.textContent = "Ready for next cycle";
  }
  if (runEl) runEl.textContent = ai && ai.lastRunAt ? fmtTime(ai.lastRunAt) : "—";
  if (decisionEl) {
    const add = Number(ai && ai.productsAddedLastRun ? ai.productsAddedLastRun : 0);
    const rem = Number(ai && ai.productsRemovedLastRun ? ai.productsRemovedLastRun : 0);
    decisionEl.textContent = "Added " + add + " · Removed " + rem;
  }
  const state = isPaused ? "paused" : hasError ? "error" : isRunning ? "running" : "idle";
  updateAIFace(state);
}

function renderSourcingCandidates(rows) {
  const body = document.getElementById("sourcing-candidates-body");
  if (!body) return;
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="6" class="hint-muted">Ingen pending candidates lige nu.</td></tr>';
    return;
  }
  body.innerHTML = list
    .map((c) => {
      const p = (c && c.candidate_payload && c.candidate_payload.row) || {};
      const title = p.title || p.name || "Untitled";
      const reason = c.decision_reason || p.brand_fit_reason || "—";
      const pop = (c.popularity_level || "unknown") + (c.sold_count != null ? " · sold " + c.sold_count : "");
      const src = c.source_platform || p.sourcePlatform || p.importMethod || "—";
      return (
        "<tr>" +
        "<td><strong>" +
        esc(String(title)) +
        "</strong><div class=\"hint-muted\">" +
        esc(String(p.category || "other")) +
        "</div></td>" +
        "<td>" +
        esc(String(src)) +
        "</td>" +
        '<td class="text-end">' +
        esc(String(Math.round(Number(c.ai_score) || 0))) +
        "</td>" +
        "<td>" +
        esc(String(pop)) +
        "</td>" +
        "<td>" +
        esc(String(reason).slice(0, 180)) +
        "</td>" +
        '<td><button type="button" class="adm-btn-ghost adm-btn-primary" data-cand-approve="' +
        esc(String(c.id)) +
        '">Approve</button> <button type="button" class="adm-btn-ghost" data-cand-reject="' +
        esc(String(c.id)) +
        '">Reject</button></td>' +
        "</tr>"
      );
    })
    .join("");

  body.querySelectorAll("[data-cand-approve]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = String(btn.getAttribute("data-cand-approve") || "").trim();
      if (!id) return;
      const reason = prompt("Approval reason:", "Approved by admin") || "Approved by admin";
      btn.disabled = true;
      const x = await apiRequest("/api/admin/sourcing-candidates/" + encodeURIComponent(id) + "/approve", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ reason }),
      });
      if (!x.ok) {
        renderAdminActionFeedback((x.data && (x.data.error || x.data.message)) || "Approve failed", "error");
      } else {
        renderAdminActionFeedback("Candidate approved and published.", "info");
      }
      refreshSourcingCandidates().catch(() => {});
      load();
    });
  });
  body.querySelectorAll("[data-cand-reject]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = String(btn.getAttribute("data-cand-reject") || "").trim();
      if (!id) return;
      const reason = prompt("Reject reason:", "Rejected by admin") || "Rejected by admin";
      btn.disabled = true;
      const x = await apiRequest("/api/admin/sourcing-candidates/" + encodeURIComponent(id) + "/reject", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ reason }),
      });
      if (!x.ok) {
        renderAdminActionFeedback((x.data && (x.data.error || x.data.message)) || "Reject failed", "error");
      } else {
        renderAdminActionFeedback("Candidate rejected.", "info");
      }
      refreshSourcingCandidates().catch(() => {});
    });
  });
}

async function refreshSourcingCandidates() {
  const body = document.getElementById("sourcing-candidates-body");
  if (!body) return;
  const r = await apiRequest("/api/admin/sourcing-candidates?limit=80", {
    headers: adminHeaders({ json: false }),
  });
  if (!r.ok) {
    body.innerHTML = '<tr><td colspan="6" class="hint-muted">Kunne ikke hente candidate queue.</td></tr>';
    return;
  }
  renderSourcingCandidates((r.data && r.data.candidates) || []);
}

function updateAIFace(status) {
  const face = document.getElementById("ai-face");
  const tip = document.getElementById("ai-face-tooltip");
  if (!face) return;
  face.classList.remove("adm-ai-face--active", "adm-ai-face--idle", "adm-ai-face--error");
  const clickHint = " · Klik for at tale";
  let text = "AI på pause" + clickHint;
  if (status === "running") {
    face.classList.add("adm-ai-face--active");
    text = "AI arbejder på butikken" + clickHint;
  } else if (status === "error") {
    face.classList.add("adm-ai-face--error");
    text = "AI-fejl — tjek log" + clickHint;
  } else {
    face.classList.add("adm-ai-face--idle");
    text = "AI på pause" + clickHint;
  }
  if (tip) tip.textContent = text;
}

const AI_BUBBLE_MAX_LINES = 4;

function updateAIFaceBubbleStack(rows, opts = {}) {
  const face = document.getElementById("ai-face");
  const stackEl = document.getElementById("ai-face-bubble-stack");
  if (!face || !stackEl) return;
  const animate = opts.animate !== false;
  const slice = (rows || []).slice(0, AI_BUBBLE_MAX_LINES);
  if (!slice.length) {
    stackEl.innerHTML = "";
    if (aiFaceBubbleTimer) clearTimeout(aiFaceBubbleTimer);
    face.classList.remove("adm-ai-face--talk");
    return;
  }
  const ordered = slice.slice().reverse();
  stackEl.innerHTML = ordered
    .map((row, i) => {
      const isNewest = i === ordered.length - 1;
      const line = humanizeAiEntry(row);
      return (
        '<p class="adm-bubble-line' +
        (isNewest ? " adm-bubble-line--new" : "") +
        '">' +
        esc(line) +
        "</p>"
      );
    })
    .join("");
  if (!animate) return;
  face.classList.add("adm-ai-face--talk");
  if (aiFaceBubbleTimer) clearTimeout(aiFaceBubbleTimer);
  aiFaceBubbleTimer = setTimeout(() => {
    face.classList.remove("adm-ai-face--talk");
  }, 5200);
}

function renderAiActivityFeed(feed) {
  const host = document.getElementById("ai-activity-feed");
  if (!host) return;
  const rows = (feed || []).slice(0, 20);
  // Do not auto-animate avatar from background logs; only bot chat should speak.
  lastAiFeedRows = rows;
  if (!rows.length) {
    host.innerHTML = '<div class="adm-feed-item"><p>Ingen AI-aktivitet endnu.</p></div>';
    return;
  }
  host.innerHTML = rows
    .map((row, idx) => {
      return (
        '<button type="button" class="adm-feed-item" data-feed-idx="' +
        idx +
        '"><p>' +
        esc(humanizeAiEntry(row)) +
        '</p><span class="adm-feed-time">' +
        esc(fmtTime(row.created_at)) +
        "</span></button>"
      );
    })
    .join("");
  host.querySelectorAll("[data-feed-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-feed-idx"));
      const row = lastAiFeedRows[idx];
      if (!row) return;
      openModal(
        "AI feed details",
        "<pre>" +
          esc(
            JSON.stringify(
              {
                created_at: row.created_at,
                action: row.action,
                message: row.message,
                reason: row.reason || null,
                ai_confidence: row.ai_confidence || null,
                product_id: row.product_id || null,
                before: row.before || null,
                after: row.after || null,
                metadata: row.metadata || null,
              },
              null,
              2
            )
          ) +
          "</pre>"
      );
    });
  });
}

async function loadAiFeed() {
  const r = await apiRequest("/api/admin/ai-feed", { headers: adminHeaders({ json: false }) });
  const body = r && r.data ? r.data : {};
  const feed = body.feed || body.data || body.entries || [];
  if (Array.isArray(feed)) renderAiActivityFeed(feed.slice(0, 20));
}

function sourcingLogDetails(row) {
  return row && row.details && typeof row.details === "object" ? row.details : {};
}

/** Kun <code>details.meta.runId</code> — deterministisk gruppering (uden cycleId/tidsvindue). */
function sourcingRunMetaRunId(row) {
  const d = sourcingLogDetails(row);
  if (!d || typeof d !== "object") return null;
  const m = d.meta;
  if (m && m.runId != null && String(m.runId).trim() !== "") return String(m.runId);
  return null;
}

const SOURCING_RUN_GROUP_ACTIONS = new Set([
  "sourcing_run_started",
  "sourcing_run_completed",
  "sourcing_no_candidates",
  "product_added",
  "product_variant_merged",
  "product_sourcing_rejected",
  "sourcing_skipped_source_policy",
  "sourcing_skipped_category_cap",
  "sourcing_skipped_user_memory",
]);

function isSourcingChatProductReject(row) {
  const d = sourcingLogDetails(row);
  return row.action === "product_sourcing_rejected" && d.channel === "sourcing_chat";
}

function sourcingRunSortKey(run) {
  const items = [
    run.started,
    run.completed,
    run.noCandidates,
    ...run.accepted,
    ...run.rejected,
    ...run.skipped,
  ].filter(Boolean);
  if (!items.length) return 0;
  return Math.max(...items.map((x) => x._t || 0));
}

function humanizeTraceReason(reason) {
  if (reason == null || reason === "") return "Afvist";
  const s = String(reason);
  const map = {
    source_policy: "Kilden var ikke valgt i dit dashboard",
    user_memory: "Ligner noget du tidligere har afvist",
    duplicate_external_id: "Allerede i kataloget",
    category_cap: "Kategoriloft (for mange i denne kategori)",
    category_intent_mismatch: "Kategori matchede ikke",
    rejected: "Vurderet som dårlig match",
  };
  if (map[s]) return map[s];
  if (s.length <= 140) return s;
  return s.slice(0, 137) + "…";
}

function humanizeNoProductsReason(code) {
  const map = {
    db_unavailable: "Database utilgaengelig",
    provider_off: "Ingen aktive providers",
    auto_import_disabled: "Auto import er slaaet fra",
    no_seed: "Ingen seed URLs konfigureret",
    filtered_out: "Kandidater blev filtreret fra",
    at_capacity: "Katalog er ved max kapacitet",
    lock_busy: "Sourcing lock er optaget",
    automation_paused: "Automation er pauseret",
    automation_busy: "Automation er optaget",
    sourcing_busy: "Sourcing koerer allerede",
  };
  const k = String(code || "").trim();
  return map[k] || "Ingen kandidater fundet";
}

function buildSourcingRunsFromFeed(feed) {
  const rows = (feed || []).map((row) => ({
    ...row,
    _t: new Date(row.created_at || 0).getTime(),
  }));
  rows.sort((a, b) => a._t - b._t);

  const runsById = new Map();
  const order = [];
  const ungrouped = [];

  function ensureRun(rid) {
    if (!runsById.has(rid)) {
      runsById.set(rid, {
        runId: rid,
        started: null,
        completed: null,
        noCandidates: null,
        rejected: [],
        accepted: [],
        skipped: [],
      });
      order.push(rid);
    }
    return runsById.get(rid);
  }

  for (const row of rows) {
    if (!SOURCING_RUN_GROUP_ACTIONS.has(row.action)) continue;
    if (isSourcingChatProductReject(row)) continue;

    const rid = sourcingRunMetaRunId(row);
    if (!rid) {
      ungrouped.push(row);
      continue;
    }

    const r = ensureRun(rid);
    const act = row.action;
    if (act === "sourcing_run_started") {
      if (!r.started) r.started = row;
    } else if (act === "sourcing_run_completed") {
      r.completed = row;
    } else if (act === "sourcing_no_candidates") {
      if (!r.noCandidates) r.noCandidates = row;
    } else if (act === "product_added" || act === "product_variant_merged") {
      r.accepted.push(row);
    } else if (act === "product_sourcing_rejected") {
      r.rejected.push(row);
    } else if (
      act === "sourcing_skipped_source_policy" ||
      act === "sourcing_skipped_category_cap" ||
      act === "sourcing_skipped_user_memory"
    ) {
      r.skipped.push(row);
    }
  }

  const runs = order.map((id) => runsById.get(id)).filter(Boolean);
  for (const r of runs) {
    r.rejected.sort((a, b) => b._t - a._t);
    r.accepted.sort((a, b) => b._t - a._t);
    r.skipped.sort((a, b) => b._t - a._t);
  }
  runs.sort((a, b) => sourcingRunSortKey(b) - sourcingRunSortKey(a));
  ungrouped.sort((a, b) => b._t - a._t);

  return { runs, ungrouped };
}

function derivedRunCounts(run) {
  const dc = run.completed ? sourcingLogDetails(run.completed) : {};
  const meta = dc.meta || {};
  const fromMeta =
    run.completed != null &&
    meta.totalCandidates != null &&
    Number.isFinite(Number(meta.totalCandidates));
  if (fromMeta) {
    const insertedFromMeta =
      meta.insertedCount != null && Number.isFinite(Number(meta.insertedCount))
        ? Number(meta.insertedCount) || 0
        : Number(meta.acceptedCount) || 0;
    const queuedFromMeta =
      meta.queuedCount != null && Number.isFinite(Number(meta.queuedCount))
        ? Number(meta.queuedCount) || 0
        : 0;
    return {
      totalCandidates: Number(meta.totalCandidates) || 0,
      accepted: insertedFromMeta,
      queued: queuedFromMeta,
      rejected: Number(meta.rejectedCount) || 0,
    };
  }
  return {
    totalCandidates: run.accepted.length + run.rejected.length,
    accepted: run.accepted.length,
    queued: 0,
    rejected: run.rejected.length,
  };
}

function runListLabel(run) {
  const st = run.started || run.completed || run.noCandidates;
  const t = st && st.created_at ? fmtTime(st.created_at) : "—";
  const counts = derivedRunCounts(run);
  const sm = run.started ? sourcingLogDetails(run.started).meta || {} : {};
  const smNc = run.noCandidates ? sourcingLogDetails(run.noCandidates).meta || {} : {};
  const srcArr =
    Array.isArray(sm.enabledSources) && sm.enabledSources.length
      ? sm.enabledSources
      : Array.isArray(smNc.enabledSources)
        ? smNc.enabledSources
        : [];
  const catArr =
    Array.isArray(sm.allowedCategories) && sm.allowedCategories.length
      ? sm.allowedCategories
      : Array.isArray(smNc.allowedCategories)
        ? smNc.allowedCategories
        : [];
  const src = srcArr.length ? srcArr.join(", ") : "—";
  const cats = catArr.length ? catArr.join(", ") : "—";
  const hasNc = run.noCandidates != null;
  const hasDone = run.completed != null;
  const total = counts.totalCandidates;
  let statusClass = "adm-sourcing-run-card__status--unk";
  let statusText = "Status ukendt (manglende log)";
  if (hasNc && (!hasDone || total === 0)) {
    statusClass = "adm-sourcing-run-card__status--warn";
    const noCode =
      (run.noCandidates &&
        run.noCandidates.details &&
        run.noCandidates.details.meta &&
        run.noCandidates.details.meta.reasonCode) ||
      (run.noCandidates && run.noCandidates.details && run.noCandidates.details.reason) ||
      "";
    statusText = "⚠ Ingen produkter (" + humanizeNoProductsReason(noCode) + ")";
  } else if (hasDone) {
    statusClass = "adm-sourcing-run-card__status--ok";
    statusText = "✓ Færdig";
  }
  const idSuffix = run.runId.length > 12 ? run.runId.slice(0, 8) + "…" : run.runId;
  return (
    '<button type="button" class="adm-sourcing-run-card' +
    (selectedSourcingRunId === run.runId ? " is-selected" : "") +
    '" data-sourcing-run-id="' +
    esc(run.runId) +
    '">' +
    '<div class="adm-sourcing-run-card__status ' +
    statusClass +
    '">' +
    esc(statusText) +
    "</div>" +
    '<div class="adm-sourcing-run-card__time">Run ' +
    esc(idSuffix) +
    " · " +
    esc(t) +
    "</div>" +
    '<div class="adm-sourcing-run-card__meta">' +
    "<strong>Kilder:</strong> " +
    esc(src) +
    " · <strong>Kategorier:</strong> " +
    esc(cats) +
    "<br/>" +
    "<strong>Kandidater:</strong> " +
    esc(String(counts.totalCandidates)) +
    " · <strong>Indsat:</strong> " +
    esc(String(counts.accepted)) +
    " · <strong>Queued:</strong> " +
    esc(String(counts.queued || 0)) +
    " · <strong>Afvist:</strong> " +
    esc(String(counts.rejected)) +
    "</div></button>"
  );
}

function renderSourcingRunDetail(run) {
  const detail = document.getElementById("sourcing-runs-detail");
  if (!detail) return;
  const smStart = run.started ? sourcingLogDetails(run.started).meta || {} : {};
  const smNc = run.noCandidates ? sourcingLogDetails(run.noCandidates).meta || {} : {};
  const counts = derivedRunCounts(run);
  const srcList = (smStart.enabledSources && smStart.enabledSources.length ? smStart.enabledSources : smNc.enabledSources) || [];
  const catList =
    (smStart.allowedCategories && smStart.allowedCategories.length ? smStart.allowedCategories : smNc.allowedCategories) || [];

  let html = '<h3 class="adm-sourcing-detail-head">Run-detaljer</h3>';
  html += '<div class="adm-sourcing-detail-summary"><dl>';
  html += "<dt>Run ID</dt><dd>" + esc(run.runId) + "</dd>";
  html += "<dt>Kilder (plan)</dt><dd>" + esc(srcList.length ? srcList.join(", ") : "—") + "</dd>";
  html += "<dt>Kategorier (niche)</dt><dd>" + esc(catList.length ? catList.join(", ") : "—") + "</dd>";
  html += "<dt>Kandidater i alt</dt><dd>" + esc(String(counts.totalCandidates)) + "</dd>";
  html += "<dt>Indsat</dt><dd>" + esc(String(counts.accepted)) + "</dd>";
  html += "<dt>Queued til admin</dt><dd>" + esc(String(counts.queued || 0)) + "</dd>";
  html += "<dt>Afvist (log)</dt><dd>" + esc(String(counts.rejected)) + "</dd>";
  if (run.completed) {
    const m = sourcingLogDetails(run.completed).meta || {};
    if (m.skippedBySource != null) {
      html += "<dt>Springet over (kilde)</dt><dd>" + esc(String(m.skippedBySource)) + "</dd>";
    }
    if (m.skippedByCategory != null) {
      html += "<dt>Springet over (kategori-loft)</dt><dd>" + esc(String(m.skippedByCategory)) + "</dd>";
    }
  }
  html += "</dl></div>";

  if (run.noCandidates) {
    const m = smNc;
    html += '<div class="adm-sourcing-alert"><strong>Ingen produkter fundet.</strong> Systemet fandt ingen kandidater i dette kørsel.';
    html +=
      "</div><p class=\"hint-muted\" style=\"margin-top:0\">Aktive kilder (efter log): <strong>" +
      esc(Array.isArray(m.enabledSources) ? m.enabledSources.join(", ") : "—") +
      '</strong>. Valgte kategorier: <strong>' +
      esc(Array.isArray(m.allowedCategories) ? m.allowedCategories.join(", ") : "—") +
      "</strong>. ";
    const reasonCode =
      m.reasonCode ||
      m.reason ||
      (run.noCandidates && run.noCandidates.details && run.noCandidates.details.reason) ||
      "";
    html +=
      "Web-crawl var " +
      (m.webEnabled ? "slået til" : "ikke aktiv") +
      " · Shopify-provider " +
      (m.shopifyEnabled ? "var aktiv" : "var ikke aktiv") +
      ".</p>";
    html +=
      '<p class="hint-muted" style="margin-top:.25rem">Aarsagskode: <strong>' +
      esc(String(reasonCode || "unknown")) +
      "</strong> · " +
      esc(humanizeNoProductsReason(reasonCode)) +
      "</p>";
  }

  html += '<p class="adm-sourcing-subhead">Godkendt / indsat</p>';
  if (!run.accepted.length) {
    html +=
      '<p class="hint-muted">Ingen produkter logget som tilføjet i dette run (eller events ligger uden for hentet log).</p>';
  } else {
    html += '<ul class="adm-sourcing-rowlist">';
    for (const row of run.accepted) {
      const d = sourcingLogDetails(row);
      const why = d.brand_fit_reason ? String(d.brand_fit_reason).slice(0, 220) : "—";
      html +=
        '<li class="adm-sourcing-row"><div class="adm-sourcing-row__title">' +
        esc(d.name || "?") +
        '</div><div class="adm-sourcing-row__sub">Kategori: ' +
        esc(d.category || "—") +
        " · Begrundelse: " +
        esc(why) +
        "</div></li>";
    }
    html += "</ul>";
  }

  html += '<p class="adm-sourcing-subhead">Sprunget over (log)</p>';
  if (!run.skipped.length) {
    html += '<p class="hint-muted">Ingen skip-events i dette run.</p>';
  } else {
    html += '<ul class="adm-sourcing-rowlist">';
    for (const row of run.skipped) {
      const d = sourcingLogDetails(row);
      const title =
        d.title ||
        (d.samples && d.samples[0] && d.samples[0].title) ||
        (d.count != null ? "Aggregeret skip" : "?");
      const sub =
        row.action === "sourcing_skipped_source_policy" && d.count != null
          ? "Kildepolitik · " + d.count + " stk."
          : row.action === "sourcing_skipped_category_cap"
            ? "Kategori-loft · " + (d.category || "—")
            : row.action === "sourcing_skipped_user_memory"
              ? "Bruger-hukommelse · " + (d.reason || "—")
              : String(row.message || row.action || "");
      html +=
        '<li class="adm-sourcing-row"><div class="adm-sourcing-row__title">' +
        esc(String(title)) +
        '</div><div class="adm-sourcing-row__sub">' +
        esc(sub) +
        "</div></li>";
    }
    html += "</ul>";
  }

  html += '<p class="adm-sourcing-subhead">Afviste kandidater</p>';
  if (!run.rejected.length) {
    html +=
      '<p class="hint-muted">Ingen afvisninger knyttet til dette run i den hentede log — tal fra resume ovenfor kan tælle andre typer spring.</p>';
  } else {
    html += '<ul class="adm-sourcing-rowlist">';
    for (const row of run.rejected) {
      const d = sourcingLogDetails(row);
      const tr = d.meta && d.meta.trace ? d.meta.trace : {};
      const traceReason = tr.rejectedReason != null ? tr.rejectedReason : d.reason;
      const src = tr.source || d.importMethod || d.sourcePlatform || "—";
      const title = d.title || (d.meta && d.meta.title) || "?";
      html +=
        '<li class="adm-sourcing-row"><div class="adm-sourcing-row__title">' +
        esc(title) +
        '</div><div class="adm-sourcing-row__sub">Afvist: ' +
        esc(humanizeTraceReason(traceReason)) +
        " · Kilde: " +
        esc(String(src)) +
        "</div></li>";
    }
    html += "</ul>";
  }

  detail.innerHTML = html;
  detail.hidden = false;
}

function renderSourcingRunsPanel(runs, ungrouped) {
  const list = document.getElementById("sourcing-runs-list");
  const detail = document.getElementById("sourcing-runs-detail");
  const ungEl = document.getElementById("sourcing-runs-ungrouped");
  const ug = ungrouped || [];

  if (ungEl) {
    if (ug.length) {
      ungEl.hidden = false;
      ungEl.innerHTML =
        '<p class="adm-sourcing-subhead">Ugrupperede (mangler <code>meta.runId</code>)</p>' +
        '<ul class="adm-sourcing-rowlist">' +
        ug
          .map(
            (row) =>
              '<li class="adm-sourcing-row"><div class="adm-sourcing-row__title">' +
              esc(row.message || row.action || "?") +
              '</div><div class="adm-sourcing-row__sub">' +
              esc(fmtTime(row.created_at)) +
              "</div></li>"
          )
          .join("") +
        "</ul>";
    } else {
      ungEl.hidden = true;
      ungEl.innerHTML = "";
    }
  }

  if (!list) return;
  if (!runs.length) {
    list.innerHTML =
      '<p class="hint-muted">Ingen sourcing-runs med <code>meta.runId</code> i den seneste AI-log. Kør automation med opdateret server — eller se ugrupperede hændelser ovenfor/nedenfor.</p>';
    if (detail) {
      detail.hidden = true;
      detail.innerHTML = "";
    }
    return;
  }
  list.innerHTML = runs.map((r) => runListLabel(r)).join("");
  list.onclick = (e) => {
    const btn = e.target.closest("[data-sourcing-run-id]");
    if (!btn) return;
    selectedSourcingRunId = btn.getAttribute("data-sourcing-run-id");
    const run = runs.find((x) => x.runId === selectedSourcingRunId);
    list.querySelectorAll(".adm-sourcing-run-card").forEach((el) => {
      el.classList.toggle("is-selected", el.getAttribute("data-sourcing-run-id") === selectedSourcingRunId);
    });
    if (run) renderSourcingRunDetail(run);
  };
  if (selectedSourcingRunId) {
    const sel = runs.find((x) => x.runId === selectedSourcingRunId);
    if (sel) renderSourcingRunDetail(sel);
    else {
      selectedSourcingRunId = null;
      if (detail) {
        detail.hidden = true;
        detail.innerHTML = "";
      }
    }
  }
}

async function refreshSourcingRunsPanel() {
  if (location.protocol === "file:") return;
  const list = document.getElementById("sourcing-runs-list");
  try {
    const r = await apiRequest("/api/admin/ai-feed", { headers: adminHeaders({ json: false }) });
    const body = r && r.data ? r.data : {};
    const feed = body.feed || [];
    const { runs, ungrouped } = buildSourcingRunsFromFeed(feed);
    renderSourcingRunsPanel(runs, ungrouped);
  } catch {
    if (list) list.innerHTML = '<p class="hint-muted">Kunne ikke hente AI-feed.</p>';
    const ungEl = document.getElementById("sourcing-runs-ungrouped");
    if (ungEl) {
      ungEl.hidden = true;
      ungEl.innerHTML = "";
    }
  }
}

function humanizeAiEntry(row) {
  const action = String((row && row.action) || "").toLowerCase();
  if (action.includes("remove")) return "AI removed low-performing products to protect margin and quality.";
  if (action.includes("price")) return "AI adjusted product prices based on demand and margin signals.";
  if (action.includes("add") || action.includes("insert")) return "AI added new products that matched your brand fit settings.";
  if (action.includes("cycle")) return "AI completed an optimization cycle and updated strategy memory.";
  return (row && row.message) || "AI activity updated";
}

function renderSinceLastVisit(data) {
  const host = document.getElementById("since-last-visit");
  if (!host) return;
  const trends = Array.isArray(data && data.trends7d) ? data.trends7d : [];
  const last24h = trends.length
    ? trends
        .slice()
        .sort((a, b) => new Date(String(b?.date || 0)).getTime() - new Date(String(a?.date || 0)).getTime())[0]
    : null;
  const profit24h = last24h && last24h.profit != null
    ? Number(last24h.profit)
    : Number(data && data.businessMetrics && data.businessMetrics.totalProfit ? data.businessMetrics.totalProfit : 0);
  const ordersTotal = Number(data && data.catalogMetrics && data.catalogMetrics.totalOrders ? data.catalogMetrics.totalOrders : 0);
  const added = Number(data && data.ai && data.ai.productsAddedLastRun ? data.ai.productsAddedLastRun : 0);
  const removed = Number(data && data.ai && data.ai.productsRemovedLastRun ? data.ai.productsRemovedLastRun : 0);
  host.innerHTML =
    '<div class="adm-top-status-card"><p class="adm-top-status-label">Products added</p><p class="adm-top-status-value">' +
    esc(String(added)) +
    "</p></div>" +
    '<div class="adm-top-status-card"><p class="adm-top-status-label">Products removed</p><p class="adm-top-status-value">' +
    esc(String(removed)) +
    "</p></div>" +
    '<div class="adm-top-status-card"><p class="adm-top-status-label">Profit 24h</p><p class="adm-top-status-value">' +
    esc(fmtCatalogPrice(profit24h)) +
    "</p></div>" +
    '<div class="adm-top-status-card"><p class="adm-top-status-label">Orders</p><p class="adm-top-status-value">' +
    esc(String(Math.max(0, Math.round(ordersTotal)))) +
    "</p></div>";
}

function renderInsights(data, ai) {
  const host = document.getElementById("ai-insights");
  if (!host) return;
  const insights = [];
  const planInsights = ai && ai.lastPlan && Array.isArray(ai.lastPlan.insights) ? ai.lastPlan.insights : [];
  planInsights.slice(0, 3).forEach((txt) => insights.push(String(txt)));
  const trends = Array.isArray(data && data.trends7d) ? data.trends7d : [];
  if (trends.length >= 2) {
    const byDateAsc = trends
      .slice()
      .sort((a, b) => new Date(String(a?.date || 0)).getTime() - new Date(String(b?.date || 0)).getTime());
    const first = byDateAsc[0];
    const last = byDateAsc[byDateAsc.length - 1];
    if (Number(last.profit || 0) > Number(first.profit || 0)) insights.push("Profit trend is improving over the last week");
    if (Number(last.avg_margin || 0) > Number(first.avg_margin || 0)) insights.push("Margins are improving in recent cycles");
  }
  if (!insights.length) insights.push("Waiting for more AI memory and trend data.");
  host.innerHTML = insights
    .slice(0, 6)
    .map((txt) => '<div class="adm-insight-item"><p>' + esc(txt) + "</p></div>")
    .join("");
}

function renderTrendCharts(data) {
  const host = document.getElementById("kpi-trend-charts");
  if (!host) return;
  const trends = Array.isArray(data && data.trends7d) ? data.trends7d : [];
  if (!trends.length) {
    host.innerHTML =
      '<div class="adm-panel"><p class="adm-mini-meta">No trend data yet.</p></div>' +
      '<div class="adm-panel"><p class="adm-mini-meta">No trend data yet.</p></div>';
    return;
  }
  const profits = trends.map((r) => Number(r && r.profit ? r.profit : 0));
  const margins = trends.map((r) => Number(r && r.avg_margin ? r.avg_margin : 0));
  host.innerHTML =
    '<div class="adm-panel">' +
    miniChartHtml("Profit trend (7d)", profits, "Total: " + profits.reduce((a, b) => a + b, 0).toFixed(0)) +
    "</div>" +
    '<div class="adm-panel">' +
    miniChartHtml(
      "Margin trend (7d)",
      margins,
      "Last: " + ((margins[margins.length - 1] || 0) * 100).toFixed(2) + "%"
    ) +
    "</div>";
}

function miniChartHtml(title, values, meta) {
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  const bars = values
    .map((v) => {
      const h = Math.max(8, Math.round((Math.abs(v) / max) * 88));
      return '<span class="adm-mini-bar" style="height:' + h + 'px"></span>';
    })
    .join("");
  return (
    '<div class="adm-mini-chart"><h3>' +
    esc(title) +
    '</h3><div class="adm-mini-bars">' +
    bars +
    '</div><p class="adm-mini-meta">' +
    esc(meta) +
    "</p></div>"
  );
}

function renderInitialSkeleton() {
  const grid = document.getElementById("adm-kpi-grid");
  if (!grid) return;
  grid.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    grid.innerHTML +=
      '<article class="adm-kpi"><div class="adm-skeleton" style="height:14px;border-radius:6px"></div><div class="adm-skeleton" style="height:34px;margin-top:10px;border-radius:8px"></div><div class="adm-skeleton" style="height:10px;margin-top:10px;border-radius:5px"></div></article>';
  }
}

function updateCeoOpsUi(ai) {
  const btn = document.getElementById("btn-ceo-toggle");
  const hint = document.getElementById("ceo-pause-hint");
  if (!btn || !hint) return;
  const off = Boolean(ai && ai.ceoPaused);
  btn.textContent = off ? "Tænd CEO-automation" : "Sluk CEO-automation";
  hint.textContent = off
    ? "Fuld CEO-cyklus er slået fra. Interval på serveren kalder stadig funktionen, men den gør ingenting."
    : "Næste fulde cykel følger serverens interval. Brug knappen hvis du vil undgå automatiske ændringer.";
}

function updateAutoImportOpsUi(cfg) {
  const btn = document.getElementById("btn-auto-import-toggle");
  const hint = document.getElementById("auto-import-hint");
  const c = cfg || currentStoreConfig;
  const on = !c || c.autoProductImport !== false;
  if (btn) btn.textContent = on ? "Slå automatisk vareimport fra" : "Tænd automatisk vareimport";
  if (hint) {
    hint.textContent = on
      ? "Varer hentes fra alle valgte kilder (web, Shopify, eBay …). Ved flere aktive kilder fordeles pladser mellem dem."
      : "Automatisk hentning af nye kandidater er slået fra (sourcing-chat og manuelle import påvirkes ikke).";
  }
  const ch = document.getElementById("cfg-auto-product-import");
  if (ch) ch.checked = on;
}

/** Opdaterer motor, KPI-autorække og plan uden at hente katalog/log igen */
function applyEnginePulse(d) {
  if (!d || !d.ok || !lastSnapshot || !lastSnapshot.ok) return;
  const merged = { ...lastSnapshot, ai: d.ai };
  lastSnapshot = merged;
  const ai = merged.ai || {};
  scaleIdSet = buildScaleIdSet(ai);
  renderCommandCenter(ai, merged, PULSE_MS, FULL_REFRESH_MS);
  renderKpiGrid(ai, merged);
  renderTopStatus(ai);
  renderInsights(merged, ai);
  renderTrendCharts(merged);
  renderPlanPanel(ai);
  updateCeoOpsUi(ai);
}

function pulseEngine() {
  if (location.protocol === "file:") return;
  if (!lastSnapshot || !lastSnapshot.ok) return;
  fetch("/api/admin/pulse", { headers: adminHeaders({ json: false }), credentials: "include", cache: "no-store" })
    .then((r) => r.json())
    .then(applyEnginePulse)
    .catch(() => {});
}

function load() {
  if (summaryLoadInFlight) {
    summaryReloadQueued = true;
    return Promise.resolve(lastSnapshot || null);
  }
  summaryLoadInFlight = true;
  if (location.protocol === "file:") {
    if (panelErr) {
      panelErr.textContent = "Open via server: http://localhost:3000/admin";
      panelErr.style.display = "block";
    }
    summaryLoadInFlight = false;
    return Promise.resolve();
  }
  if (panelErr) panelErr.style.display = "none";
  if (!hasLoadedSummary) renderInitialSkeleton();
  return apiRequest("/api/admin/summary", { headers: adminHeaders({ json: false }), retries: 1 })
    .then((resp) => {
      if (resp.status === 401) {
        flashAdminAuthBannerError("401: Udfyld X-Admin-Secret (samme som ADMIN_SECRET på Netlify).");
        goToCatalogAndFocusSecret();
        renderFullSummary({ ok: false });
        if (panelErr) {
          panelErr.textContent =
            "Mangler/forkert admin-kode. Udfyld X-Admin-Secret, ellers kan dashboard-data ikke vises.";
          panelErr.style.display = "block";
        }
        return resp.data;
      }
      const data = resp.data || { ok: false, error: resp.message || "Could not load summary." };
      if (data && data.ok) lastSnapshot = data;
      renderFullSummary(data);
      loadAiFeed().catch(() => {});
      if (data && data.ok) hasLoadedSummary = true;
      return data;
    })
    .catch(() => {
      if (panelErr) {
        panelErr.textContent = "Could not reach /api/admin/summary — is the server running?";
        panelErr.style.display = "block";
      }
      if (lastSnapshot && lastSnapshot.ok) {
        renderFullSummary(lastSnapshot);
      }
      const dot = document.getElementById("ops-pulse-dot");
      const lab = document.getElementById("ops-pulse-label");
      if (dot) dot.className = "adm-dot adm-dot--idle";
      if (lab) lab.textContent = "—";
      refreshFulfillmentInbox(false).catch(() => {});
      refreshFulfillmentPanel().catch(() => {});
    })
    .finally(() => {
      summaryLoadInFlight = false;
      if (summaryReloadQueued) {
        summaryReloadQueued = false;
        setTimeout(() => {
          load();
        }, 0);
      }
    });
}

/* Tabs */
(function initTabs() {
  const KEY = "velden_admin_page";
  const tabs = Array.prototype.slice.call(document.querySelectorAll("[data-page-tab]"));
  const pages = Array.prototype.slice.call(document.querySelectorAll("[data-page]"));
  function setActive(pageId, opts) {
    tabs.forEach((b) => {
      const on = b.getAttribute("data-page-tab") === pageId;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    pages.forEach((p) => {
      p.classList.toggle("is-active", p.getAttribute("data-page") === pageId);
    });
    try {
      if (!opts || !opts.noStore) localStorage.setItem(KEY, pageId);
    } catch {
      /* ignore */
    }
  }
  const REMOVED_PAGE_IDS = new Set(["log", "plan"]);
  function normalizePageId(id) {
    if (!id) return id;
    return REMOVED_PAGE_IDS.has(id) ? "overview" : id;
  }
  function pickInitial() {
    const hash = String(location.hash || "").replace(/^#/, "").trim();
    if (hash) return normalizePageId(hash);
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) return normalizePageId(saved);
    } catch {
      /* ignore */
    }
    return "overview";
  }
  tabs.forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.getAttribute("data-page-tab");
      setActive(id);
      if (history && history.replaceState) history.replaceState(null, "", "#" + id);
      if (id === "overview") refreshSourcingRunsPanel().catch(() => {});
      if (id === "sourcing") refreshSourcingCandidates().catch(() => {});
      const targetSel = b.getAttribute("data-scroll-target");
      if (targetSel) {
        const target = document.querySelector(targetSel);
        if (target) {
          setTimeout(() => {
            target.scrollIntoView({ behavior: "smooth", block: "start" });
          }, 60);
        }
      }
    });
  });
  const topBtn = document.querySelector("[data-admin-scroll-top]");
  if (topBtn) {
    topBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
  const rawHash = String(location.hash || "").replace(/^#/, "").trim();
  const initial = pickInitial();
  setActive(initial, { noStore: false });
  if (rawHash && REMOVED_PAGE_IDS.has(rawHash) && history && history.replaceState) {
    history.replaceState(null, "", "#" + initial);
  }
  try {
    document.dispatchEvent(new CustomEvent("velden-admin-tabs-ready"));
  } catch {
    /* ignore */
  }
})();

/* Filters */
["f-search", "f-status", "f-platform", "f-country", "f-import", "f-smin", "f-smax"].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", applyFiltersAndRender);
  el.addEventListener("input", applyFiltersAndRender);
});
document.getElementById("f-reset")?.addEventListener("click", () => {
  const ids = ["f-search", "f-status", "f-platform", "f-country", "f-import", "f-smin", "f-smax"];
  ids.forEach((id) => {
    const e = document.getElementById(id);
    if (e) e.value = "";
  });
  trashViewEnabled = false;
  syncTrashToggleUi();
  applyFiltersAndRender();
});
document.getElementById("btn-trash-toggle")?.addEventListener("click", () => {
  trashViewEnabled = !trashViewEnabled;
  syncTrashToggleUi();
  applyFiltersAndRender();
});

/* Modal */
document.getElementById("modal-close")?.addEventListener("click", closeModal);
document.getElementById("modal-overlay")?.addEventListener("click", (e) => {
  if (e.target.id === "modal-overlay") closeModal();
});

document.getElementById("btn-auto-import-toggle")?.addEventListener("click", () => {
  const on = currentStoreConfig && currentStoreConfig.autoProductImport !== false;
  const next = !on;
  fetch("/api/admin/store-config", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "include",
    body: JSON.stringify({ config: { autoProductImport: next } }),
  })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, j };
    })
    .then((x) => {
      if (x.j && x.j.ok) {
        currentStoreConfig = x.j.config;
        updateAutoImportOpsUi(x.j.config);
      } else if (x.status === 401) {
        flashAdminAuthBannerError("401: Udfyld X-Admin-Secret (samme som ADMIN_SECRET).");
        goToCatalogAndFocusSecret();
      } else {
        alert((x.j && x.j.error) || "Kunne ikke ændre automatisk vareimport.");
      }
    })
    .catch(() => alert("Netværksfejl."));
});

document.getElementById("btn-ceo-toggle")?.addEventListener("click", () => {
  const ai = lastSnapshot?.ai;
  const nextPaused = !(ai && ai.ceoPaused);
  fetch("/api/admin/automation/ceo-pause", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "include",
    body: JSON.stringify({ paused: nextPaused }),
  })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, j };
    })
    .then((x) => {
      if (x.j && x.j.ok) {
        pulseEngine();
        load();
      } else if (x.status === 401) {
        flashAdminAuthBannerError("401: Udfyld X-Admin-Secret (samme som ADMIN_SECRET).");
        goToCatalogAndFocusSecret();
      } else {
        alert((x.j && x.j.error) || "Kunne ikke ændre CEO-pause.");
      }
    })
    .catch(() => alert("Netværksfejl."));
});

document.getElementById("btn-purge-all")?.addEventListener("click", () => {
  if (!confirm("Slette ALLE produkter permanent fra databasen? Ordre bevares, men product_id nulstilles.")) return;
  const raw = document.getElementById("purge-confirm-input")?.value ?? "";
  const phrase = String(raw).trim();
  if (phrase !== "SLET_ALLE_PRODUKTER") {
    alert('Skriv præcis SLET_ALLE_PRODUKTER i feltet over knappen (ingen ekstra mellemrum).');
    return;
  }
  fetch("/api/admin/products/purge-all", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "include",
    body: JSON.stringify({ confirm: "SLET_ALLE_PRODUKTER" }),
  })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, j };
    })
    .then((x) => {
      if (x.j && x.j.ok) {
        alert("Slettet " + (x.j.deleted ?? 0) + " produkter.");
        load();
      } else if (x.status === 401) {
        flashAdminAuthBannerError("401: Udfyld X-Admin-Secret.");
        goToCatalogAndFocusSecret();
      } else {
        alert((x.j && x.j.error) || "Purge fejlede.");
      }
    })
    .catch(() => alert("Netværksfejl."));
});

document.getElementById("btn-shopify-import")?.addEventListener("click", () => {
  const input = document.getElementById("shopify-import-url");
  const statusEl = document.getElementById("shopify-import-status");
  const shopUrl = (input && input.value.trim()) || "";
  const collectionHandle = document.getElementById("shopify-collection-handle")?.value.trim() || "";
  const forceCategory = document.getElementById("shopify-force-category")?.value.trim() || "";
  if (!shopUrl) {
    if (statusEl) statusEl.textContent = "Indtast butikkens https-URL (rod eller /collections/…).";
    return;
  }
  if (statusEl) statusEl.textContent = "Importerer…";
  const body = { shopUrl };
  if (collectionHandle) body.collectionHandle = collectionHandle;
  if (forceCategory) body.forceCategory = forceCategory;
  fetch("/api/admin/import/shopify", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "include",
    body: JSON.stringify(body),
  })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, j };
    })
    .then((x) => {
      if (x.j && x.j.ok) {
        const msg =
          "Hentet " +
          (x.j.fetched ?? "—") +
          " · indsat " +
          (x.j.inserted ?? 0) +
          " · variant-merge " +
          (x.j.merged ?? 0) +
          " · sprunget over " +
          (x.j.skipped ?? 0);
        if (statusEl) statusEl.textContent = msg;
        load();
      } else if (x.status === 401) {
        if (statusEl) statusEl.textContent = "";
        flashAdminAuthBannerError("401: Udfyld X-Admin-Secret.");
        goToCatalogAndFocusSecret();
      } else {
        if (statusEl) statusEl.textContent = (x.j && x.j.error) || "Import fejlede.";
        alert((x.j && x.j.error) || "Import fejlede.");
      }
    })
    .catch(() => {
      if (statusEl) statusEl.textContent = "Netværksfejl.";
    });
});

function splitCsv(v) {
  return String(v || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function splitHttpsSeedLines(v) {
  return String(v || "")
    .split(/[,;\n\r]+/)
    .map((s) => s.trim())
    .filter((u) => /^https?:\/\//i.test(u));
}

function updatePricePreview() {
  const min = Number(document.getElementById("cfg-price-min")?.value || 0);
  const max = Number(document.getElementById("cfg-price-max")?.value || 0);
  const out = document.getElementById("cfg-price-preview");
  if (out) out.value = min + " - " + max;
}

function syncAggressivenessLabel() {
  const range = document.getElementById("ai-aggressiveness");
  const val = document.getElementById("ai-aggressiveness-value");
  if (range && val) val.textContent = String(range.value || "0");
}

let NICH_VERTICAL = {};
let ALL_MERGED_CATEGORY_IDS = ["other"];
let TAXONOMY_LABELS = {};

function buildNichVerticalFromPayload(data) {
  const map = {};
  for (const v of data.verticals || []) {
    map[v.key] = v;
  }
  map.all = {
    key: "all",
    label: "Alle kategorier",
    categoryIds: data.allCategoryIds || ["other"],
  };
  return map;
}

/** Bruges af både statisk JSON og API — undgår tom UI hvis admin-endpoint fejler. */
function applyTaxonomyPayload(payload) {
  if (!payload || !Array.isArray(payload.verticals) || !Array.isArray(payload.allCategoryIds)) return false;
  if (!payload.verticals.length || !payload.allCategoryIds.length) return false;
  NICH_VERTICAL = buildNichVerticalFromPayload(payload);
  ALL_MERGED_CATEGORY_IDS = payload.allCategoryIds;
  TAXONOMY_LABELS = payload.labels && typeof payload.labels === "object" ? payload.labels : {};
  return true;
}

async function bootstrapAdminTaxonomy() {
  try {
    const res = await fetch("/data/store-taxonomy.json", { credentials: "same-origin", cache: "no-cache" });
    if (res.ok) {
      const j = await res.json();
      if (applyTaxonomyPayload(j)) return;
    }
  } catch (_) {
    /* file:// */
  }
  try {
    const r = await apiRequest("/api/admin/category-taxonomy", { headers: adminHeaders({ json: false }) });
    const j = r && r.data ? r.data : null;
    if (j && j.verticals && j.allCategoryIds && applyTaxonomyPayload(j)) return;
  } catch (_) {
    /* netværk */
  }
  NICH_VERTICAL = {
    fashion: {
      key: "fashion",
      label: "👕 Tøj & mode",
      categoryIds: ["shirts", "trousers", "knitwear", "other"],
    },
    all: { key: "all", label: "Alle kategorier", categoryIds: ["shirts", "trousers", "knitwear", "other"] },
  };
  ALL_MERGED_CATEGORY_IDS = ["shirts", "trousers", "knitwear", "other"];
  TAXONOMY_LABELS = { shirts: "Skjorter", trousers: "Bukser", knitwear: "Strik", other: "Andet" };
}

const SOURCE_OPTIONS = [
  { id: "web", label: "Web / scraping" },
  { id: "shopify", label: "Shopify" },
  { id: "ebay", label: "eBay" },
  { id: "alibaba", label: "Alibaba" },
  { id: "cjdropshipping", label: "CJ Dropshipping" },
];

function categoryLabelDa(slug) {
  return TAXONOMY_LABELS[slug] || slug;
}

function inferVerticalKey(categorySlugs) {
  const ids = (categorySlugs || []).map((x) => String(x).trim()).filter(Boolean);
  if (!ids.length) return "fashion";
  for (const v of Object.values(NICH_VERTICAL)) {
    if (!v || v.key === "all") continue;
    const set = new Set(v.categoryIds);
    if (ids.every((id) => set.has(id))) return v.key;
  }
  return "all";
}

function fillVerticalSelect() {
  const sel = document.getElementById("cfg-vertical-select");
  if (!sel) return;
  const verts = Object.values(NICH_VERTICAL).filter((v) => v && v.key !== "all");
  const allV = NICH_VERTICAL.all;
  /** «Alle kategorier» først — så dukker, maling m.m. er synlige uden at lede i bunden. */
  const list = allV ? [allV, ...verts] : verts;
  if (!list.length) return;
  sel.innerHTML = list
    .map((v) => '<option value="' + esc(v.key) + '">' + esc(v.label) + "</option>")
    .join("");
}

function fillSourcePickSelect() {
  const sel = document.getElementById("cfg-source-pick");
  if (!sel) return;
  sel.innerHTML =
    '<option value="">Vælg kilde…</option>' +
    SOURCE_OPTIONS.map((o) => '<option value="' + esc(o.id) + '">' + esc(o.label) + "</option>").join("");
}

function refillCategoryPick(verticalKey) {
  const sel = document.getElementById("cfg-category-pick");
  if (!sel) return;
  const def =
    NICH_VERTICAL[verticalKey] ||
    NICH_VERTICAL.all ||
    ({ categoryIds: ALL_MERGED_CATEGORY_IDS });
  const ids = def.categoryIds || ALL_MERGED_CATEGORY_IDS;
  sel.innerHTML =
    '<option value="">Vælg kategori…</option>' +
    ids.map((id) => '<option value="' + esc(id) + '">' + esc(categoryLabelDa(id)) + "</option>").join("");
}

/** Live opsummering under kategori-chips: samme liste for web, Shopify, eBay m.m. */
function updateImportCategorySummary() {
  const hidden = document.getElementById("cfg-cats");
  const out = document.getElementById("cfg-import-categories-summary");
  if (!out) return;
  const slugs = splitCsv(hidden?.value || "").filter(Boolean);
  if (!slugs.length) {
    out.innerHTML =
      "<strong>Ingen kategori-chips endnu.</strong> Uden chips sætter du ingen fast kategori-grænse — brand-fit, pris og " +
      "blokerede ord gælder stadig. <strong>Tilføj chips</strong> ovenfor for at styre sortimentet på <strong>alle</strong> " +
      "importkilder (web begrænser seeds/crawl, markedspladser målretter søgning, og afvigende kandidater afvises). " +
      "Valgfrit reserve for eBay uden chips: <code>EBAY_DISCOVERY_QUERY</code> i miljø.";
    return;
  }
  const labels = slugs.map((s) => categoryLabelDa(s));
  out.innerHTML =
    "<strong>Aktive kategorier</strong> (alle kilder: web, Shopify, eBay …): " +
    esc(labels.join(", ")) +
    ".";
}

function syncCategoriesHiddenFromChips() {
  const host = document.getElementById("cfg-category-chips");
  const hidden = document.getElementById("cfg-cats");
  if (!host || !hidden) return;
  const slugs = Array.prototype.map
    .call(host.querySelectorAll("[data-chip-slug]"), (el) => el.getAttribute("data-chip-slug"))
    .filter(Boolean);
  hidden.value = slugs.join(", ");
  updateImportCategorySummary();
}

function syncSourcesHiddenFromChips() {
  const host = document.getElementById("cfg-source-chips");
  const hidden = document.getElementById("cfg-sources");
  if (!host || !hidden) return;
  const slugs = Array.prototype.map
    .call(host.querySelectorAll("[data-chip-slug]"), (el) => el.getAttribute("data-chip-slug"))
    .filter(Boolean);
  hidden.value = slugs.join(", ");
}

function syncBlockedHiddenFromChips() {
  const host = document.getElementById("cfg-blocked-chips");
  const hidden = document.getElementById("cfg-blocked");
  if (!host || !hidden) return;
  const words = Array.prototype.map
    .call(host.querySelectorAll("[data-chip-slug]"), (el) => el.getAttribute("data-chip-slug"))
    .filter(Boolean);
  hidden.value = words.join(", ");
}

/** @param {string} raw */
function parseBlockedKeywordTokens(raw) {
  return String(raw || "")
    .split(/[,;|\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function addBlockedChipsFromInput() {
  const input = document.getElementById("cfg-blocked-input");
  const host = document.getElementById("cfg-blocked-chips");
  if (!input || !host) return;
  const parts = parseBlockedKeywordTokens(input.value);
  if (!parts.length) return;
  const existingLower = new Set(
    Array.from(host.querySelectorAll("[data-chip-slug]")).map((el) =>
      String(el.getAttribute("data-chip-slug") || "").toLowerCase()
    )
  );
  for (const token of parts) {
    if (existingLower.has(token.toLowerCase())) continue;
    existingLower.add(token.toLowerCase());
    const span = document.createElement("span");
    span.className = "adm-chip";
    span.setAttribute("data-chip-slug", token);
    span.innerHTML =
      '<span class="adm-chip__text">' +
      esc(token) +
      '</span><button type="button" class="adm-chip__remove" data-remove-chip aria-label="Fjern">×</button>';
    host.appendChild(span);
  }
  syncBlockedHiddenFromChips();
  input.value = "";
}

function renderBlockedChips(keywords) {
  const host = document.getElementById("cfg-blocked-chips");
  if (!host) return;
  const uniq = [];
  const seen = new Set();
  for (const x of keywords || []) {
    const w = String(x || "").trim();
    if (!w) continue;
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(w);
  }
  host.innerHTML = uniq
    .map((word) => {
      return (
        '<span class="adm-chip" data-chip-slug="' +
        esc(word) +
        '"><span class="adm-chip__text">' +
        esc(word) +
        '</span><button type="button" class="adm-chip__remove" data-remove-chip aria-label="Fjern">×</button></span>'
      );
    })
    .join("");
  syncBlockedHiddenFromChips();
  const input = document.getElementById("cfg-blocked-input");
  if (input) input.value = "";
}

/** Valgte kilder (lowercase) fra chips — tom liste = intet valgt endnu. */
function selectedEnabledSourceIds() {
  syncSourcesHiddenFromChips();
  const hidden = document.getElementById("cfg-sources");
  const raw = hidden && hidden.value ? hidden.value : "";
  return splitCsv(raw)
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
}

/** Under web / Shopify / eBay: vis detaljefelter kun når tilsvarende «Aktivér» er slået til. */
function syncSourcingProviderDetailVisibility() {
  const webOn = Boolean(document.getElementById("cfg-web-enabled")?.checked);
  const webFields = document.getElementById("cfg-web-detail-fields");
  const webHint = document.getElementById("cfg-web-detail-hint");
  if (webFields) webFields.hidden = !webOn;
  if (webHint) webHint.hidden = webOn;

  const shopOn = Boolean(document.getElementById("cfg-shopify-enabled")?.checked);
  const shopFields = document.getElementById("cfg-shopify-detail-fields");
  const shopHint = document.getElementById("cfg-shopify-detail-hint");
  if (shopFields) shopFields.hidden = !shopOn;
  if (shopHint) shopHint.hidden = shopOn;

}

/** Vis kun sektion for valgte kilde (samme mønster som eBay / Alibaba). */
function updateSourcingSectionsVisibility() {
  const ids = new Set(selectedEnabledSourceIds());
  const has = (slug) => ids.has(String(slug).toLowerCase());
  const showWeb = has("web");
  const showShopify = has("shopify");
  const showEbay = has("ebay");
  const showAli = has("alibaba");
  const showMp = showEbay || showAli;
  const hasAnySource = ids.size > 0;

  const toggle = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.hidden = !on;
  };

  toggle("cfg-section-web", showWeb);
  toggle("cfg-section-shopify", showShopify);
  toggle("cfg-section-ebay", showEbay);
  toggle("int-section-ebay", showEbay);
  toggle("int-section-alibaba", showAli);
  toggle("int-marketplaces-header", showMp);
  const pick = document.getElementById("int-marketplaces-pick-hint");
  if (pick) pick.hidden = showMp;
  const srcHint = document.getElementById("cfg-sources-pick-hint");
  if (srcHint) srcHint.hidden = hasAnySource;

  const hintEl = document.getElementById("int-api-hint");
  if (hintEl) {
    const hasText = String(hintEl.textContent || "").trim().length > 0;
    hintEl.hidden = !showMp || !hasText;
  }

  if (showWeb || showShopify) syncSourcingProviderDetailVisibility();
}

function renderCategoryChips(slugs) {
  const host = document.getElementById("cfg-category-chips");
  if (!host) return;
  const uniq = [...new Set((slugs || []).map((x) => String(x).trim()).filter(Boolean))];
  host.innerHTML = uniq
    .map((slug) => {
      return (
        '<span class="adm-chip" data-chip-slug="' +
        esc(slug) +
        '"><span class="adm-chip__text">' +
        esc(categoryLabelDa(slug)) +
        '</span><button type="button" class="adm-chip__remove" data-remove-chip aria-label="Fjern">×</button></span>'
      );
    })
    .join("");
  syncCategoriesHiddenFromChips();
}

function renderSourceChips(ids) {
  const host = document.getElementById("cfg-source-chips");
  if (!host) return;
  const uniq = [...new Set((ids || []).map((x) => String(x).trim()).filter(Boolean))];
  const labelFor = (id) => {
    const o = SOURCE_OPTIONS.find((s) => s.id === id);
    return o ? o.label : id;
  };
  host.innerHTML = uniq
    .map((id) => {
      return (
        '<span class="adm-chip" data-chip-slug="' +
        esc(id) +
        '"><span class="adm-chip__text">' +
        esc(labelFor(id)) +
        '</span><button type="button" class="adm-chip__remove" data-remove-chip aria-label="Fjern">×</button></span>'
      );
    })
    .join("");
  syncSourcesHiddenFromChips();
}

function wireStoreConfigPickers() {
  document.getElementById("cfg-web-enabled")?.addEventListener("change", syncSourcingProviderDetailVisibility);
  document.getElementById("cfg-shopify-enabled")?.addEventListener("change", syncSourcingProviderDetailVisibility);
  document.getElementById("cfg-auto-product-import")?.addEventListener("change", (e) => {
    const on = e.target && e.target.checked;
    updateAutoImportOpsUi({ ...(currentStoreConfig || {}), autoProductImport: on });
  });
  document.getElementById("cfg-category-chips")?.addEventListener("click", (e) => {
    if (!e.target.closest("[data-remove-chip]")) return;
    e.target.closest("[data-chip-slug]")?.remove();
    syncCategoriesHiddenFromChips();
  });
  document.getElementById("cfg-source-chips")?.addEventListener("click", (e) => {
    if (!e.target.closest("[data-remove-chip]")) return;
    e.target.closest("[data-chip-slug]")?.remove();
    syncSourcesHiddenFromChips();
    updateSourcingSectionsVisibility();
  });
  document.getElementById("cfg-blocked-chips")?.addEventListener("click", (e) => {
    if (!e.target.closest("[data-remove-chip]")) return;
    e.target.closest("[data-chip-slug]")?.remove();
    syncBlockedHiddenFromChips();
  });
  document.getElementById("btn-blocked-add")?.addEventListener("click", () => addBlockedChipsFromInput());
  document.getElementById("cfg-blocked-input")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    addBlockedChipsFromInput();
  });
  document.getElementById("cfg-vertical-select")?.addEventListener("change", (e) => {
    refillCategoryPick(e.target.value || "fashion");
  });
  document.getElementById("btn-category-add")?.addEventListener("click", () => {
    const sel = document.getElementById("cfg-category-pick");
    const v = (sel && sel.value) || "";
    if (!String(v).trim()) return;
    const host = document.getElementById("cfg-category-chips");
    if (!host) return;
    const dup = Array.from(host.querySelectorAll("[data-chip-slug]")).some(
      (el) => el.getAttribute("data-chip-slug") === v
    );
    if (dup) return;
    const span = document.createElement("span");
    span.className = "adm-chip";
    span.setAttribute("data-chip-slug", v);
    span.innerHTML =
      '<span class="adm-chip__text">' +
      esc(categoryLabelDa(v)) +
      '</span><button type="button" class="adm-chip__remove" data-remove-chip aria-label="Fjern">×</button>';
    host.appendChild(span);
    syncCategoriesHiddenFromChips();
    sel.value = "";
  });
  document.getElementById("btn-source-add")?.addEventListener("click", () => {
    const sel = document.getElementById("cfg-source-pick");
    const v = (sel && sel.value) || "";
    if (!String(v).trim()) return;
    const host = document.getElementById("cfg-source-chips");
    if (!host) return;
    const dup = Array.from(host.querySelectorAll("[data-chip-slug]")).some(
      (el) => el.getAttribute("data-chip-slug") === v
    );
    if (dup) return;
    const o = SOURCE_OPTIONS.find((x) => x.id === v);
    const label = o ? o.label : v;
    const span = document.createElement("span");
    span.className = "adm-chip";
    span.setAttribute("data-chip-slug", v);
    span.innerHTML =
      '<span class="adm-chip__text">' +
      esc(label) +
      '</span><button type="button" class="adm-chip__remove" data-remove-chip aria-label="Fjern">×</button>';
    host.appendChild(span);
    syncSourcesHiddenFromChips();
    updateSourcingSectionsVisibility();
    sel.value = "";
  });
}

function setSelectIfValid(id, val, fallback) {
  const el = document.getElementById(id);
  if (!el || el.tagName !== "SELECT") return;
  const fb = String(fallback != null ? fallback : "");
  const v = String(val == null || val === "" ? fb : val).trim();
  const ok = Array.prototype.some.call(el.options, (o) => o.value === v);
  el.value = ok ? v : fb;
}

function hydrateConfigForm(cfg) {
  if (!cfg) return;
  currentStoreConfig = cfg;
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val == null ? "" : String(val);
  };
  const int = cfg.integrations || {};
  const ebay = int.ebay || {};
  const ali = int.alibaba || {};
  set("int-ebay-client-id", ebay.clientId || "");
  set("int-ebay-dev-id", ebay.devId || "");
  set("int-ebay-client-secret", "");
  set("int-ebay-oauth", "");
  set("int-alibaba-key", ali.appKey || "");
  set("int-alibaba-secret", "");
  set("int-alibaba-token", "");
  const hintParts = [];
  if (ebay.clientSecretSet) hintParts.push("eBay client secret gemt");
  if (ebay.oauthTokenSet) hintParts.push("eBay OAuth gemt");
  if (ali.appSecretSet) hintParts.push("Alibaba secret gemt");
  if (ali.accessTokenSet) hintParts.push("Alibaba token gemt");
  const hintEl = document.getElementById("int-api-hint");
  if (hintEl) hintEl.textContent = hintParts.length ? hintParts.join(" · ") + " — udfyld kun felter du vil ændre." : "";
  set("cfg-brand", cfg.brand || "");
  set("cfg-price-min", cfg.priceRange && cfg.priceRange.min);
  set("cfg-price-max", cfg.priceRange && cfg.priceRange.max);
  renderBlockedChips(cfg.blockedKeywords || []);
  const stratGoal = (cfg.strategy && cfg.strategy.goal) || "maximize_profit";
  const stratRisk = (cfg.strategy && cfg.strategy.risk) || "balanced";
  setSelectIfValid("cfg-goal", stratGoal, "maximize_profit");
  setSelectIfValid("cfg-risk", stratRisk, "balanced");
  set("cfg-max-catalog", cfg.maxCatalogProducts != null && cfg.maxCatalogProducts > 0 ? cfg.maxCatalogProducts : "");
  const webProv =
    cfg.sourcing && cfg.sourcing.providers && cfg.sourcing.providers.web ? cfg.sourcing.providers.web : {};
  const webEn = document.getElementById("cfg-web-enabled");
  if (webEn) webEn.checked = webProv.enabled !== false;
  set("cfg-web-seeds-global", (webProv.seedUrls || []).join("\n"));
  const byCat = webProv.seedsByCategory && typeof webProv.seedsByCategory === "object" ? webProv.seedsByCategory : {};
  set(
    "cfg-web-seeds-by-cat",
    Object.keys(byCat).length ? JSON.stringify(byCat, null, 2) : ""
  );
  const shopProv =
    cfg.sourcing && cfg.sourcing.providers && cfg.sourcing.providers.shopify ? cfg.sourcing.providers.shopify : {};
  const shEn = document.getElementById("cfg-shopify-enabled");
  if (shEn) shEn.checked = shopProv.enabled === true;
  set("cfg-shopify-store-url", shopProv.storeUrl || "");
  set("cfg-shopify-admin-host", shopProv.adminShopHost || "");
  set("cfg-shopify-collection-handle", shopProv.collectionHandle || "");
  set("cfg-shopify-admin-token", "");
  const shHint = document.getElementById("cfg-shopify-token-hint");
  if (shHint) {
    shHint.textContent = shopProv.accessTokenSet
      ? "Token gemt — udfyld kun ved nyt token. Uden token bruges offentlig storefront JSON (hvis butikken eksponerer den)."
      : "Uden token: discovery bruger /products.json. Med token: angiv *.myshopify.com i butiks-URL eller «Admin API-butik» ved custom domæne.";
  }
  const ebayProv =
    cfg.sourcing && cfg.sourcing.providers && cfg.sourcing.providers.ebay ? cfg.sourcing.providers.ebay : {};
  const ebayEn = document.getElementById("cfg-ebay-browse-enabled");
  if (ebayEn) ebayEn.checked = ebayProv.enabled === true;
  const merch = cfg.sourcing && cfg.sourcing.merchandising ? cfg.sourcing.merchandising : {};
  setSelectIfValid("cfg-merch-focus", merch.focus || "balanced", "balanced");
  set("cfg-merch-season", merch.seasonNote || "");
  set("cfg-merch-vibe", merch.vibeKeywords || "");
  const autoImp = document.getElementById("cfg-auto-product-import");
  if (autoImp) autoImp.checked = cfg.autoProductImport !== false;
  syncSourcingProviderDetailVisibility();
  updateAutoImportOpsUi(cfg);
  fillVerticalSelect();
  fillSourcePickSelect();
  const catList = cfg.allowedCategories || [];
  const vk = String(cfg.adminVerticalKey || "").trim();
  let vert = vk && NICH_VERTICAL[vk] ? vk : inferVerticalKey(catList);
  if (vk && NICH_VERTICAL[vk] && catList.length) {
    const allowed = new Set(NICH_VERTICAL[vk].categoryIds || []);
    const ids = catList.map((x) => String(x).trim()).filter(Boolean);
    if (!ids.every((id) => allowed.has(id))) vert = inferVerticalKey(catList);
  }
  if (!vert || !NICH_VERTICAL[vert]) vert = catList.length ? inferVerticalKey(catList) : "all";
  if (!vert || !NICH_VERTICAL[vert]) vert = "fashion";
  const vSel = document.getElementById("cfg-vertical-select");
  if (vSel) vSel.value = vert;
  refillCategoryPick(vert);
  renderCategoryChips(catList);
  renderSourceChips(cfg.enabledSources || []);
  updateSourcingSectionsVisibility();
  set("ai-aggressiveness", Math.round(Number((cfg.strategy && cfg.strategy.pricingAggressiveness) || 0.5) * 100));
  setSelectIfValid("ai-strategy", stratGoal, "maximize_profit");
  updatePricePreview();
  syncAggressivenessLabel();
  refreshSourcingHealth();
}

function formatAdminFetchError(j, status) {
  if (j && typeof j.message === "string" && j.message.trim()) return j.message.trim();
  if (j && j.error && typeof j.error === "object" && typeof j.error.code === "string") {
    const c = j.error.code;
    const base = j.message && String(j.message).trim() ? String(j.message).trim() : c;
    return c === "UNAUTHORIZED"
      ? base + " — tjek at X-Admin-Secret / cookie matcher ADMIN_SECRET i .env."
      : base;
  }
  if (j && typeof j.error === "string" && j.error.trim()) return j.error.trim();
  if (status === 404) {
    return (
      "HTTP 404: Serveren kender ikke /api/admin/sourcing-health. Genstart Node med «npm run dev» fra projekt-mappen " +
      "(samme version som indeholder denne knap). Åbn admin på samme host/port som API (fx http://localhost:3000/admin.html)."
    );
  }
  return "Kunne ikke læse leverandør-status (" + status + "). Tjek ADMIN_SECRET / login.";
}

async function refreshSourcingHealth() {
  const btn = document.getElementById("btn-sourcing-health");
  const logEl = document.getElementById("sourcing-health-log");
  if (!btn || !logEl) return;
  btn.classList.remove("is-ok", "is-err", "is-busy");
  logEl.textContent = "Henter status…";
  btn.classList.add("is-busy");
  try {
    const r = await fetch("/api/admin/sourcing-health", { headers: adminHeaders({ json: false }), credentials: "include" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j || j.ok === false) {
      btn.classList.add("is-err");
      logEl.textContent = formatAdminFetchError(j, r.status);
      return;
    }
    const h = j.health || {};
    const lines = Array.isArray(h.logLines) && h.logLines.length ? h.logLines : ["(ingen kilder at tjekke)"];
    logEl.textContent = lines.join("\n");
    if (h.ok) btn.classList.add("is-ok");
    else btn.classList.add("is-err");
  } catch (e) {
    btn.classList.add("is-err");
    logEl.textContent = e && e.message ? e.message : "Netværksfejl.";
  } finally {
    btn.classList.remove("is-busy");
  }
}

function loadStoreConfig() {
  return apiRequest("/api/admin/store-config", { headers: adminHeaders({ json: false }) })
    .then((resp) => {
      const j = resp && resp.data ? resp.data : null;
      if (j && j.ok) hydrateConfigForm(j.config);
    })
    .catch((e) => {
      renderAdminActionFeedback(
        "Kunne ikke indlæse store config: " + (e && e.message ? e.message : "ukendt fejl"),
        "error"
      );
    });
}

document.getElementById("btn-save-config")?.addEventListener("click", () => {
  const statusEl = document.getElementById("cfg-status");
  syncCategoriesHiddenFromChips();
  syncSourcesHiddenFromChips();
  syncBlockedHiddenFromChips();
  const enabledSourcesList = splitCsv(document.getElementById("cfg-sources")?.value || "");
  const srcSet = new Set(enabledSourcesList.map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  const hasSrc = (slug) => srcSet.has(String(slug).toLowerCase());

  let seedsByCategoryWeb = {};
  const catJsonRaw = document.getElementById("cfg-web-seeds-by-cat")?.value.trim() || "";
  if (hasSrc("web") && catJsonRaw) {
    try {
      const parsed = JSON.parse(catJsonRaw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        if (statusEl) statusEl.textContent = "Per-kategori seeds: JSON skal være et objekt { \"shirts\": [\"https://...\"] }.";
        return;
      }
      seedsByCategoryWeb = parsed;
    } catch {
      if (statusEl) statusEl.textContent = "Per-kategori seeds: ugyldig JSON.";
      return;
    }
  }

  const sourcingProviders = {};
  if (hasSrc("web")) {
    sourcingProviders.web = {
      enabled: document.getElementById("cfg-web-enabled")?.checked !== false,
      seedUrls: splitHttpsSeedLines(document.getElementById("cfg-web-seeds-global")?.value),
      seedsByCategory: seedsByCategoryWeb,
    };
  } else {
    sourcingProviders.web = { enabled: false };
  }
  if (hasSrc("shopify")) {
    const o = {
      enabled: document.getElementById("cfg-shopify-enabled")?.checked === true,
      storeUrl: document.getElementById("cfg-shopify-store-url")?.value.trim() || "",
      adminShopHost: document.getElementById("cfg-shopify-admin-host")?.value.trim() || "",
      collectionHandle: document.getElementById("cfg-shopify-collection-handle")?.value.trim() || "",
    };
    const tok = document.getElementById("cfg-shopify-admin-token")?.value || "";
    if (tok.trim()) o.accessToken = tok.trim();
    sourcingProviders.shopify = o;
  } else {
    sourcingProviders.shopify = { enabled: false };
  }
  if (hasSrc("ebay")) {
    sourcingProviders.ebay = {
      enabled: document.getElementById("cfg-ebay-browse-enabled")?.checked === true,
    };
  } else {
    sourcingProviders.ebay = { enabled: false };
  }

  const integrations = {};
  if (hasSrc("ebay")) {
    integrations.ebay = {
      clientId: document.getElementById("int-ebay-client-id")?.value.trim() || "",
      devId: document.getElementById("int-ebay-dev-id")?.value.trim() || "",
      clientSecret: document.getElementById("int-ebay-client-secret")?.value || "",
      oauthToken: document.getElementById("int-ebay-oauth")?.value || "",
    };
  }
  if (hasSrc("alibaba")) {
    integrations.alibaba = {
      appKey: document.getElementById("int-alibaba-key")?.value.trim() || "",
      appSecret: document.getElementById("int-alibaba-secret")?.value || "",
      accessToken: document.getElementById("int-alibaba-token")?.value || "",
    };
  }

  const body = {
    config: {
      brand: document.getElementById("cfg-brand")?.value.trim() || "Velden",
      adminVerticalKey: document.getElementById("cfg-vertical-select")?.value.trim() || "",
      priceRange: {
        min: Number(document.getElementById("cfg-price-min")?.value || 0) || 0,
        max: Number(document.getElementById("cfg-price-max")?.value || 0) || 0,
      },
      allowedCategories: splitCsv(document.getElementById("cfg-cats")?.value || ""),
      blockedKeywords: splitCsv(document.getElementById("cfg-blocked")?.value),
      strategy: {
        goal: document.getElementById("cfg-goal")?.value || "maximize_profit",
        risk: document.getElementById("cfg-risk")?.value || "balanced",
      },
      maxCatalogProducts: (() => {
        const raw = String(document.getElementById("cfg-max-catalog")?.value || "").trim();
        if (raw === "") return 0;
        const n = Math.floor(Number(raw));
        return Number.isFinite(n) && n > 0 ? n : 0;
      })(),
      autoProductImport: document.getElementById("cfg-auto-product-import")?.checked !== false,
      enabledSources: enabledSourcesList,
      sourcing: {
        merchandising: {
          focus: document.getElementById("cfg-merch-focus")?.value || "balanced",
          seasonNote: document.getElementById("cfg-merch-season")?.value.trim() || "",
          vibeKeywords: document.getElementById("cfg-merch-vibe")?.value.trim() || "",
        },
        providers: sourcingProviders,
      },
    },
  };
  if (Object.keys(integrations).length) {
    body.config.integrations = integrations;
  }
  if (statusEl) statusEl.textContent = "Gemmer...";
  fetch("/api/admin/store-config", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "include",
    body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .then((j) => {
      if (j && j.ok) {
        if (statusEl) statusEl.textContent = "Gemt.";
        hydrateConfigForm(j.config);
        [
          "int-ebay-client-secret",
          "int-ebay-oauth",
          "int-alibaba-secret",
          "int-alibaba-token",
          "cfg-shopify-admin-token",
        ].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.value = "";
        });
        refreshSourcingHealth();
      } else {
        if (statusEl) statusEl.textContent = (j && j.error) || "Kunne ikke gemme.";
      }
    })
    .catch(() => {
      if (statusEl) statusEl.textContent = "Netværksfejl.";
    });
});

document.getElementById("btn-ai-start")?.addEventListener("click", async () => {
  const s = document.getElementById("ai-control-status");
  if (s) s.textContent = "Starting AI...";
  const x = await apiRequest("/api/admin/automation/ceo-pause", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ paused: false }),
  });
  if (s) {
    s.textContent = x.ok
      ? "AI started."
      : (x && x.message) || (x.data && (x.data.message || x.data.error)) || "Could not start AI.";
  }
  load();
});

document.getElementById("btn-ai-pause")?.addEventListener("click", async () => {
  const s = document.getElementById("ai-control-status");
  if (s) s.textContent = "Pausing AI...";
  const x = await apiRequest("/api/admin/automation/ceo-pause", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ paused: true }),
  });
  if (s) {
    s.textContent = x.ok
      ? "AI paused."
      : (x && x.message) || (x.data && (x.data.message || x.data.error)) || "Could not pause AI.";
  }
  load();
});

document.getElementById("btn-sourcing-health")?.addEventListener("click", () => refreshSourcingHealth());

document.getElementById("ai-aggressiveness")?.addEventListener("input", syncAggressivenessLabel);
document.getElementById("cfg-price-min")?.addEventListener("input", updatePricePreview);
document.getElementById("cfg-price-max")?.addEventListener("input", updatePricePreview);
document.getElementById("ai-strategy")?.addEventListener("change", () => {
  const pick = document.getElementById("ai-strategy")?.value || "";
  setSelectIfValid("cfg-goal", pick, "maximize_profit");
});

document.getElementById("cfg-goal")?.addEventListener("change", () => {
  const pick = document.getElementById("cfg-goal")?.value || "";
  setSelectIfValid("ai-strategy", pick, "maximize_profit");
});

initSeoPage();
wireSourcingChat(load);
initBotAssistant(load);
syncTrashToggleUi();
wireStoreConfigPickers();
updateSourcingSectionsVisibility();
bootstrapAdminTaxonomy()
  .then(() => {
    fillVerticalSelect();
    return loadStoreConfig();
  })
  .catch(() => {
    fillVerticalSelect();
    loadStoreConfig();
  });
wireFulfillmentInboxList();
startFulfillmentInboxAutoRefresh();
load();
setInterval(load, FULL_REFRESH_MS);
setInterval(pulseEngine, PULSE_MS);
setInterval(() => {
  refreshFulfillmentPanel().catch(() => {});
}, FULFILLMENT_PANEL_REFRESH_MS);
