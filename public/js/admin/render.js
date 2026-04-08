import { esc, fmtTime, fmtCatalogPrice, scoreBand } from "./utils.js";
import {
  hasCompleteSource,
  buildStatusDescriptors,
  displaySupplier,
  skuLine,
  platformBadgeLabel,
} from "./status-model.js";

/** @param {object} row logFeed row */
export function logActionKind(action) {
  const a = String(action || "").toLowerCase();
  if (a.includes("error")) return "error";
  if (a.includes("removed") || a.includes("delete")) return "remove";
  if (a.includes("added") || a.includes("inserted")) return "add";
  if (a.includes("complete") || a.includes("pass")) return "cycle";
  if (a.includes("rejected")) return "reject";
  if (a.includes("scale")) return "scale";
  if (a.includes("price")) return "price";
  if (a.includes("content")) return "content";
  return "default";
}

export function renderLog(feed) {
  const el = document.getElementById("log-timeline");
  if (!el) return;
  el.innerHTML = "";
  if (!feed || !feed.length) {
    el.innerHTML =
      '<div class="adm-log-empty">No log entries yet. Events appear after each engine pass.</div>';
    return;
  }
  feed.forEach((row) => {
    const kind = logActionKind(row.action);
    const chips = logChips(row);
    const div = document.createElement("div");
    div.className = "adm-log-row adm-log-row--" + kind;
    div.innerHTML =
      '<div class="adm-log-row__time">' +
      esc(fmtTime(row.created_at)) +
      '</div><div class="adm-log-row__body">' +
      '<span class="adm-log-row__action">' +
      esc(row.action || "event") +
      "</span>" +
      '<p class="adm-log-row__msg">' +
      esc(row.message || "") +
      '</p></div><div class="adm-log-row__meta">' +
      chips +
      "</div>";
    el.appendChild(div);
  });
}

function logChips(row) {
  const d = (row && row.details) || {};
  const chips = [];
  const inserted = Number(d.inserted);
  const candidates = Number(d.candidatesSeen);
  const target = Number(d.target);
  const removed = Number(d.removeProductIds);
  const rej = Number(d.rejectedCount);
  const qual = Number(d.qualifiedAfterAi);
  if (Number.isFinite(inserted)) chips.push('<span class="adm-log-chip">inserted ' + esc(String(inserted)) + "</span>");
  if (Number.isFinite(candidates)) chips.push('<span class="adm-log-chip">candidates ' + esc(String(candidates)) + "</span>");
  if (Number.isFinite(target)) chips.push('<span class="adm-log-chip">target ' + esc(String(target)) + "</span>");
  if (Number.isFinite(rej) && rej > 0) chips.push('<span class="adm-log-chip">AI afvist ' + esc(String(rej)) + "</span>");
  if (Number.isFinite(qual) && qual >= 0) chips.push('<span class="adm-log-chip">kvalificeret ' + esc(String(qual)) + "</span>");
  if (Number.isFinite(removed)) chips.push('<span class="adm-log-chip">removed ' + esc(String(removed)) + "</span>");
  if (!chips.length) chips.push('<span class="adm-log-chip">event</span>');
  return chips.join("");
}

/**
 * @param {number} pulseMs — hvor ofte motor pulser (visning)
 * @param {number} [fullSyncMs] — fuld katalog-sync interval (default = pulseMs)
 */
export function renderCommandCenter(ai, data, pulseMs, fullSyncMs) {
  const fullMs = fullSyncMs != null ? fullSyncMs : pulseMs;
  const dot = document.getElementById("ops-pulse-dot");
  const plab = document.getElementById("ops-pulse-label");
  const running = Boolean(ai && ai.running);
  const sourcing = Boolean(ai && ai.sourcingRunning);
  if (dot && plab) {
    if (running) {
      dot.className = "adm-dot adm-dot--run";
      plab.textContent = "Fuld cykel";
    } else if (sourcing) {
      dot.className = "adm-dot adm-dot--run";
      plab.textContent = "Sourcing";
    } else {
      dot.className = "adm-dot adm-dot--idle";
      plab.textContent = "Standby";
    }
  }

  const ih = ai && ai.nextIntervalHours != null ? Number(ai.nextIntervalHours) : 0;
  const im = ai && ai.nextIntervalMinutes != null ? Number(ai.nextIntervalMinutes) : ih * 60;
  const nextAt =
    ai && ai.lastRunAt
      ? new Date(new Date(ai.lastRunAt).getTime() + Number(ih) * 3600000)
      : null;

  const nextEl = document.getElementById("adm-next-cycle");
  if (nextEl) {
    if (running) nextEl.textContent = "I gang …";
    else if (nextAt && !Number.isNaN(nextAt.getTime())) {
      const intervalLabel = im < 60 ? Math.round(im) + " min" : Math.round(ih * 10) / 10 + " t";
      nextEl.textContent = fmtTime(nextAt.toISOString()) + " · interval " + intervalLabel;
    } else if (ai && ai.lastRunAt) {
      const intervalLabel = im < 60 ? Math.round(im) + " min" : Math.round(ih * 10) / 10 + " t";
      nextEl.textContent = "Efter sidste kørsel + " + intervalLabel;
    }
    else nextEl.textContent = "—";
  }

  const srcEl = document.getElementById("adm-sourcing-freq");
  if (srcEl) {
    const sm = ai && ai.sourcingIntervalMinutes != null ? Number(ai.sourcingIntervalMinutes) : null;
    let srcTxt = sm == null || Number.isNaN(sm) ? "Ikke angivet (genindlæs admin)" : "";
    if (sm != null && !Number.isNaN(sm)) {
      const m = Math.round(sm * 10) / 10;
      const whole = Math.round(m);
      srcTxt =
        Math.abs(m - whole) < 0.01 ? "Hvert " + whole + ". minut" : "Ca. hver " + m + " min";
    }
    if (ai && ai.sourcingIntervalMs != null && !Number.isNaN(Number(ai.sourcingIntervalMs))) {
      srcEl.setAttribute("title", "SOURCING_INTERVAL_MS=" + String(Math.round(Number(ai.sourcingIntervalMs))));
    } else {
      srcEl.removeAttribute("title");
    }
    if (ai && ai.sourcingLastRunAt) srcTxt += " · seneste " + fmtTime(ai.sourcingLastRunAt);
    if (ai && ai.sourcingLastInserted != null && ai.sourcingLastInserted > 0)
      srcTxt += " · +" + ai.sourcingLastInserted + " SKU";
    if (ai && ai.sourcingLastError) srcTxt += " · " + ai.sourcingLastError;
    srcEl.textContent = srcTxt;
  }

  const meta = document.getElementById("refresh-meta");
  if (meta) {
    meta.innerHTML =
      '<span class="adm-live-pill" title="Motorstatus opdateres løbende">' +
      '<span class="adm-live-dot" aria-hidden="true"></span> Live</span> · Motor ' +
      "<strong>" +
      esc(fmtTime(new Date().toISOString())) +
      "</strong> · Fuld katalog-sync hver " +
      fullMs / 1000 +
      " s · Pulstakt " +
      pulseMs / 1000 +
      " s";
  }

  const ceoPaused = Boolean(ai && ai.ceoPaused);
  const pill = document.getElementById("ai-status-pill");
  if (pill) {
    const label = ceoPaused ? "CEO fra" : running ? "Cykel kører" : sourcing ? "Sourcing" : "Standby";
    const tone = ceoPaused ? "idle" : running || sourcing ? "run" : "idle";
    pill.innerHTML = '<span class="adm-pill adm-pill--' + tone + '">' + label + "</span>";
  }
}

export function renderKpiGrid(ai, data) {
  const grid = document.getElementById("adm-kpi-grid");
  if (!grid) return;
  const p = data.products || {};
  const bm = data.businessMetrics || {};
  const trends = Array.isArray(data.trends7d) ? data.trends7d : [];
  const last24h = trends.length ? trends[trends.length - 1] : null;
  const profit24h = last24h && last24h.profit != null ? Number(last24h.profit) : Number(bm.totalProfit || 0);
  const profit7d = trends.reduce((sum, row) => sum + Number(row && row.profit ? row.profit : 0), 0);
  const active = p.shopVisible != null ? p.shopVisible : p.active != null ? p.active : data.productCount ?? "—";
  const conversion = bm.avgConversionRate != null ? Number(bm.avgConversionRate) : 0;
  const aov = bm.AOV != null ? Number(bm.AOV) : 0;

  const cards = [
    {
      key: "profit24h",
      label: "Profit 24h",
      value: fmtCatalogPrice(profit24h),
      sub: "Last 24 hours",
      subTone: "ok",
    },
    {
      key: "profit7d",
      label: "Profit 7d",
      value: fmtCatalogPrice(profit7d),
      sub: "Rolling 7 days",
      subTone: "muted",
    },
    {
      key: "aov",
      label: "AOV",
      value: fmtCatalogPrice(aov),
      sub: "Average order value",
      subTone: "muted",
    },
    {
      key: "conversion",
      label: "Conversion rate",
      value: (conversion * 100).toFixed(2) + "%",
      sub: "Orders per view",
      subTone: "muted",
    },
    {
      key: "active",
      label: "Active products",
      value: active,
      sub: "Visible in shop",
      subTone: "muted",
    },
  ];

  grid.innerHTML = cards
    .map(
      (c) =>
        `<article class="adm-kpi adm-kpi--${esc(c.key)}" data-kpi="${esc(c.key)}">` +
        `<p class="adm-kpi__label">${esc(c.label)}</p>` +
        `<p class="adm-kpi__value">${esc(String(c.value))}</p>` +
        `<p class="adm-kpi__sub adm-kpi__sub--${esc(c.subTone)}">${esc(c.sub)}</p>` +
        `</article>`
    )
    .join("");

}

export function statusBadgesHtml(p, scaleIdSet) {
  const descriptors = buildStatusDescriptors(p, scaleIdSet);
  if (!descriptors.length) return '<div class="adm-badge-row"><span class="adm-badge adm-badge--muted">—</span></div>';
  return (
    '<div class="adm-badge-row">' +
    descriptors
      .map(
        (d) =>
          '<span class="adm-badge adm-badge--' +
          esc(d.tone) +
          '" data-status="' +
          esc(d.key) +
          '">' +
          esc(d.label) +
          "</span>"
      )
      .join("") +
    "</div>"
  );
}

export function originCellHtml(p) {
  const pl = p.sourcePlatform || "";
  const plBadge = platformBadgeLabel(p) || pl || "—";
  const sup = displaySupplier(p);
  const cty = p.supplierCountry || "—";
  const im = p.importMethod ? p.importMethod.toUpperCase() : "—";
  const hasUrl = Boolean(p.sourceUrl);

  if (!hasCompleteSource(p)) {
    return (
      '<div class="adm-origin">' +
      (pl
        ? '<span class="adm-badge adm-badge--platform">' + esc(plBadge) + "</span>"
        : '<span class="adm-badge adm-badge--warning">No platform</span>') +
      '<div class="adm-origin__supplier">' +
      esc(sup) +
      "</div>" +
      '<div class="adm-origin__meta">' +
      esc(cty) +
      " · " +
      esc(im) +
      "</div>" +
      '<span class="adm-origin__link adm-origin__link--muted">No external link</span></div>'
    );
  }

  return (
    '<div class="adm-origin">' +
    '<span class="adm-badge adm-badge--platform">' +
    esc(plBadge) +
    "</span>" +
    '<div class="adm-origin__supplier">' +
    esc(sup) +
    "</div>" +
    '<div class="adm-origin__meta">' +
    esc(cty) +
    " · " +
    esc(im) +
    "</div>" +
    (hasUrl
      ? '<a class="adm-origin__link" href="' +
        esc(p.sourceUrl) +
        '" target="_blank" rel="noopener">Source</a>'
      : '<span class="adm-origin__link adm-origin__link--muted">No link</span>') +
    "</div>"
  );
}

export function formatDecisionCard(d) {
  if (!d || typeof d !== "object") {
    return { type: "Entry", body: esc(String(d)) };
  }
  const t = (d.type || "action").toString();
  let body = "";
  if (t === "remove") body = (d.name || d.id || "SKU") + " — removed from assortment";
  else if (t === "scale") body = (d.name || d.id || "SKU") + " — marked for scale";
  else if (t === "price")
    body =
      (d.name || d.id || "SKU") +
      " — price " +
      (d.oldPrice != null ? d.oldPrice : "?") +
      " → " +
      (d.newPrice != null ? d.newPrice : "?");
  else body = JSON.stringify(d);
  return { type: t, body: body };
}

export function planSummaryLines(plan) {
  const lines = [];
  if (!plan || typeof plan !== "object") return lines;
  if (plan.addProducts != null) lines.push({ text: "New listings requested: " + plan.addProducts, kind: "add" });
  const rm = plan.removeProductIds || plan.removeIds;
  if (Array.isArray(rm) && rm.length)
    lines.push({ text: "Removals planned: " + rm.length + " SKU(s)", kind: "remove" });
  const sc = plan.scaleProductIds || plan.scaleIds;
  if (Array.isArray(sc) && sc.length)
    lines.push({ text: "Scale targets: " + sc.length + " SKU(s)", kind: "scale" });
  const pr = plan.priceUpdates || plan.priceAdjustments;
  if (Array.isArray(pr) && pr.length)
    lines.push({ text: "Price adjustments: " + pr.length, kind: "price" });
  const ct = plan.contentTargets || plan.contentProductIds;
  if (Array.isArray(ct) && ct.length)
    lines.push({ text: "Content refresh targets: " + ct.length, kind: "content" });
  if (Array.isArray(plan.insights) && plan.insights.length)
    lines.push({ text: "Insights recorded: " + plan.insights.length, kind: "insight" });
  return lines;
}

export function renderPlanPanel(ai) {
  const ul = document.getElementById("plan-summary-lines");
  const grid = document.getElementById("decision-cards");
  const raw = document.getElementById("plan-raw");
  if (!ul || !grid || !raw) return;

  const plan = ai.lastPlan || {};
  ul.innerHTML = "";
  const slines = planSummaryLines(plan);
  if (!slines.length) {
    const li = document.createElement("li");
    li.className = "adm-plan-li adm-plan-li--muted";
    li.textContent = "No structured summary in the last response — see JSON panel.";
    ul.appendChild(li);
  } else {
    slines.forEach((item) => {
      const li = document.createElement("li");
      li.className = "adm-plan-li adm-plan-li--" + item.kind;
      li.textContent = item.text;
      ul.appendChild(li);
    });
  }

  grid.innerHTML = "";
  const decisions = ai.decisionsLastRun || [];
  if (!decisions.length) {
    const empty = document.createElement("div");
    empty.className = "adm-decision-card";
    empty.innerHTML =
      '<span class="adm-decision-card__type">Cycle</span><p class="adm-decision-card__body">No granular decisions logged for the last run.</p>';
    grid.appendChild(empty);
  } else {
    decisions.forEach((d) => {
      const fc = formatDecisionCard(d);
      const card = document.createElement("div");
      card.className = "adm-decision-card";
      card.setAttribute("data-decision-type", fc.type);
      card.innerHTML =
        '<span class="adm-decision-card__type">' +
        esc(fc.type) +
        '</span><p class="adm-decision-card__body">' +
        esc(fc.body) +
        "</p>";
      grid.appendChild(card);
    });
  }
  raw.textContent = JSON.stringify(plan, null, 2);
}

export function renderCatalogRows(rows, catalogNormalized, scaleIdSet, wireRowActions) {
  const tbody = document.getElementById("catalog-body");
  const table = document.getElementById("catalog-table");
  const empty = document.getElementById("catalog-empty");
  const emptyF = document.getElementById("catalog-empty-filter");
  if (!tbody || !table || !empty || !emptyF) return;

  tbody.innerHTML = "";
  empty.style.display = "none";
  emptyF.style.display = "none";
  table.style.display = "table";

  if (!catalogNormalized.length) {
    table.style.display = "none";
    empty.style.display = "block";
    empty.innerHTML =
      '<h3 class="adm-empty-title">AI is starting to build your catalog...</h3>' +
      '<p class="adm-empty-lead">Automation will populate rows when candidates pass brand-fit and metadata checks.</p>' +
      '<p class="adm-empty-note">Only <strong>approved</strong> sourcing appears on the storefront. Traceability requires platform + source URL where applicable.</p>';
    return;
  }
  if (!rows.length) {
    emptyF.style.display = "block";
    return;
  }

  rows.forEach((p) => {
    const tr = document.createElement("tr");
    tr.className = "adm-catalog-tr";
    if (p.opsStatus === "removed") tr.classList.add("adm-catalog-tr--removed");
    else if (!hasCompleteSource(p)) tr.classList.add("adm-catalog-tr--attention");

    const img = p.image
      ? '<img class="adm-thumb" src="' + esc(p.image) + '" alt="" loading="lazy" />'
      : '<div class="adm-thumb adm-thumb--ph">—</div>';
    const band = scoreBand(p.aiScore);
    const confidence = Number(p._raw && p._raw.confidence_score);
    const scoreValue = Number(p.aiScore);
    const pct = Number.isFinite(scoreValue) ? Math.max(0, Math.min(100, scoreValue)) : 0;
    const hue = Math.round((pct / 100) * 120);
    const scoreHtml =
      p.aiScore != null && p.aiScore !== ""
        ? '<div class="adm-score adm-score--' +
          esc(band.short || "weak") +
          '"><span class="adm-score__label">' +
          esc(band.label) +
          '</span><div class="adm-scorebar"><span class="adm-scorebar__fill" style="width:' +
          esc(String(pct)) +
          "%;background:hsl(" +
          esc(String(hue)) +
          ',65%,45%)"></span></div><span class="adm-score__meta">score ' +
          esc(String(Math.round(pct))) +
          " · conf " +
          esc(Number.isFinite(confidence) ? confidence.toFixed(0) : "—") +
          "</span></div>"
        : '<div class="adm-score adm-score--empty">—</div>';

    const copyDis = !p.sourceUrl ? " disabled" : "";
    const primaryAction =
      p.sourcingPrimary === "draft" && p.opsStatus !== "removed"
        ? '<button type="button" class="adm-act-btn adm-act-btn--approve" data-approve-id="' +
          esc(p.id) +
          '">Godkend</button>'
        : p.opsStatus !== "removed"
          ? '<button type="button" class="adm-act-btn adm-act-btn--danger" data-delete-id="' +
            esc(p.id) +
            '">Remove</button>'
          : '<button type="button" class="adm-act-btn" data-restore-id="' +
            esc(p.id) +
            '">Gendan</button>';
    const actions =
      '<div class="adm-actions">' +
      primaryAction +
      '<details class="adm-action-menu"><summary>More</summary><div class="adm-action-menu-panel">' +
      (p.sourceUrl
        ? '<a class="adm-act" href="' + esc(p.sourceUrl) + '" target="_blank" rel="noopener">Source</a>'
        : '<span class="adm-act adm-act--disabled">Source</span>') +
      '<button type="button" class="adm-act-btn" data-copy="' +
      esc(p.sourceUrl) +
      '"' +
      copyDis +
      ">Copy URL</button>" +
      '<button type="button" class="adm-act-btn" data-modal="meta" data-id="' +
      esc(p.id) +
      '">Metadata</button>' +
      '<button type="button" class="adm-act-btn" data-modal="reason" data-id="' +
      esc(p.id) +
      '">AI reason</button>' +
      (p.opsStatus === "removed"
        ? ""
        : '<button type="button" class="adm-act-btn" data-optimize-id="' +
          esc(p.id) +
          '">Force optimize</button>') +
      "</div></details></div>";

    tr.innerHTML =
      '<td class="adm-td-product"><div class="adm-product-cell">' +
      img +
      '<div class="adm-product-meta"><p class="adm-product-name">' +
      esc(p.name || p.title || "—") +
      '</p><p class="adm-product-sku">' +
      esc(skuLine(p)) +
      "</p></div></div></td>" +
      '<td class="adm-td-cat"><span class="adm-cat">' +
      esc(p.categoryLabel || p.category || "—") +
      "</span></td>" +
      '<td class="adm-td-price">' +
      fmtCatalogPrice(p.price) +
      "</td>" +
      "<td>" +
      statusBadgesHtml(p, scaleIdSet) +
      "</td>" +
      "<td>" +
      originCellHtml(p) +
      "</td>" +
      '<td class="adm-td-score">' +
      scoreHtml +
      "</td>" +
      "<td>" +
      actions +
      "</td>";
    tbody.appendChild(tr);
  });
  wireRowActions(tbody);
}

export function renderAttention(rows, applyFilterAndScroll) {
  const wrap = document.getElementById("attention-strip");
  const inner = document.getElementById("attention-inner");
  if (!wrap || !inner) return;
  if (!rows.length) {
    wrap.style.display = "none";
    return;
  }
  let miss = 0;
  let draft = 0;
  let rej = 0;
  rows.forEach((p) => {
    if (p.opsStatus === "removed") return;
    if (!hasCompleteSource(p)) miss++;
    if (p.sourcingPrimary === "draft") draft++;
    if (p.sourcingPrimary === "rejected") rej++;
  });
  if (!miss && !draft && !rej) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "flex";
  const chunks = [];
  if (miss)
    chunks.push(
      '<button type="button" class="adm-attn-link" data-attn="missing-source">' +
        miss +
        " missing source</button>"
    );
  if (draft)
    chunks.push('<button type="button" class="adm-attn-link" data-attn="draft">' + draft + " drafts</button>");
  if (rej)
    chunks.push(
      '<button type="button" class="adm-attn-link" data-attn="rejected">' + rej + " rejected</button>"
    );
  inner.innerHTML = chunks.join('<span class="adm-attn-sep">·</span>');
  inner.querySelectorAll("[data-attn]").forEach((btn) => {
    btn.addEventListener("click", () => applyFilterAndScroll(btn.getAttribute("data-attn")));
  });
}

export function renderAdminActionFeedback(message, tone) {
  var host = document.getElementById("adm-auth-banner") || document.getElementById("err-banner");
  if (!host) return;
  if (!message) {
    if (!host.classList.contains("adm-auth-banner--warn")) host.style.display = "none";
    return;
  }
  host.style.display = "block";
  host.classList.remove("adm-auth-banner--warn");
  host.textContent = message;
  if (tone === "error") host.classList.add("adm-auth-banner--warn");
}
