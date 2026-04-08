import { esc, adminHeaders, fmtCatalogPrice } from "./utils.js";

let lastSourcingCandidate = null;

function currentBrandName() {
  const el = document.getElementById("cfg-brand");
  const v = el && typeof el.value === "string" ? el.value.trim() : "";
  return v || "Velden";
}

function messageFromAny(payload, fallback) {
  const p = payload || {};
  if (typeof p === "string") return p;
  if (typeof p.message === "string" && p.message.trim()) return p.message;
  if (typeof p.error === "string" && p.error.trim()) return p.error;
  if (p.error && typeof p.error === "object") {
    if (typeof p.error.message === "string" && p.error.message.trim()) return p.error.message;
    if (typeof p.error.code === "string" && p.error.code.trim()) return p.error.code;
  }
  if (p.data && typeof p.data === "object") {
    if (typeof p.data.message === "string" && p.data.message.trim()) return p.data.message;
    if (typeof p.data.error === "string" && p.data.error.trim()) return p.data.error;
    if (p.data.error && typeof p.data.error === "object") {
      if (typeof p.data.error.message === "string" && p.data.error.message.trim()) return p.data.error.message;
      if (typeof p.data.error.code === "string" && p.data.error.code.trim()) return p.data.error.code;
    }
  }
  return fallback || "Ukendt fejl";
}

export function ensureSourcingChatSessionId() {
  const k = "velden_sourcing_chat_sid";
  try {
    let s = localStorage.getItem(k);
    if (!s) {
      s = "sc-" + Math.random().toString(36).slice(2, 12) + "-" + Date.now().toString(36);
      localStorage.setItem(k, s);
    }
    return s;
  } catch {
    return "sc-fallback-" + String(Date.now());
  }
}

export function appendSourcingChatBubble(role, htmlInner) {
  const thread = document.getElementById("sourcing-chat-thread");
  if (!thread) return;
  const div = document.createElement("div");
  div.className = "adm-sc-msg adm-sc-msg--" + (role === "user" ? "user" : "assistant");
  const label = role === "user" ? "You" : "Assistant";
  div.innerHTML =
    '<div class="adm-sc-msg__label">' +
    esc(label) +
    '</div><div class="adm-sc-msg__body">' +
    htmlInner +
    "</div>";
  thread.appendChild(div);
  thread.scrollTop = thread.scrollHeight;
}

export function formatChatCandidateCard(c) {
  if (!c) return "";
  const img =
    c.image && String(c.image).trim()
      ? '<img class="adm-sc-thumb" src="' + esc(c.image) + '" alt="" loading="lazy" />'
      : "";
  const url = c.sourceUrl
    ? '<a href="' + esc(c.sourceUrl) + '" target="_blank" rel="noopener">Åbn kilde</a>'
    : "—";
  const src = fmtCatalogPrice(c.sourcePrice != null ? c.sourcePrice : c.cost);
  const shop = fmtCatalogPrice(c.veldenShopPrice != null ? c.veldenShopPrice : c.shopPrice);
  const brandLabel = currentBrandName() + " pris";
  const relLevel = String(c.relevanceLevel || "low").toLowerCase();
  const relLabel = c.relevanceLabelDa || (relLevel === "high" ? "Hoj" : relLevel === "medium" ? "Mellem" : "Lav");
  const relReason = c.relevanceReason || "";
  return (
    '<div class="adm-sc-candidate">' +
    img +
    "<h4>" +
    esc(c.name || "—") +
    "</h4>" +
    "<dl>" +
    "<dt>Kategori</dt><dd>" +
    esc(c.category || "—") +
    "</dd>" +
    "<dt>Kildepris</dt><dd>" +
    esc(src) +
    "</dd>" +
    "<dt>" +
    esc(brandLabel) +
    "</dt><dd>" +
    esc(shop) +
    "</dd>" +
    "<dt>AI score</dt><dd>" +
    esc(c.aiScore != null ? String(c.aiScore) : "—") +
    "</dd>" +
    "<dt>Kategori-match</dt><dd>" +
    '<span class="adm-sc-rel adm-sc-rel--' +
    esc(relLevel) +
    '">' +
    esc(relLabel) +
    "</span>" +
    (relReason ? '<span class="adm-sc-rel-note"> ' + esc(relReason) + "</span>" : "") +
    "</dd>" +
    "<dt>Platform</dt><dd>" +
    esc(c.sourcePlatform || "—") +
    "</dd>" +
    "<dt>Leverandør</dt><dd>" +
    esc(c.supplierName || c.sourceName || "—") +
    "</dd>" +
    "<dt>Land</dt><dd>" +
    esc(c.supplierCountry || "—") +
    "</dd>" +
    "<dt>Import</dt><dd>" +
    esc(c.importMethod || "—") +
    "</dd>" +
    "<dt>Source ID</dt><dd>" +
    esc(c.sourceProductId || "—") +
    "</dd>" +
    "<dt>URL</dt><dd>" +
    url +
    "</dd>" +
    "</dl>" +
    '<div class="adm-sc-reason"><strong>Brand fit</strong> · ' +
    esc(c.brandFitReason || "—") +
    "</div></div>"
  );
}

export function setSourcingChatLoading(on) {
  const el = document.getElementById("sourcing-chat-loading");
  const btn = document.getElementById("sourcing-chat-send");
  const inp = document.getElementById("sourcing-chat-input");
  if (el) el.style.display = on ? "block" : "none";
  if (btn) btn.disabled = !!on;
  if (inp) inp.disabled = !!on;
}

/** @param {() => void} reloadCatalog */
export function sendSourcingChatMessage(reloadCatalog) {
  if (location.protocol === "file:") return;
  const inp = document.getElementById("sourcing-chat-input");
  if (!inp) return;
  const msg = inp.value.trim();
  if (!msg) return;
  inp.value = "";
  appendSourcingChatBubble("user", '<p class="adm-sc-plain">' + esc(msg) + "</p>");
  setSourcingChatLoading(true);
  const fetchOpts = {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      sessionId: ensureSourcingChatSessionId(),
      message: msg,
      // Netlify/serverless-safe: send the currently shown candidate with yes/no replies.
      candidate:
        /^(ja|yes|y|j|ok|okay|godkend|bekræft|confirm)\b/i.test(msg) ||
        /^(nej|no|n|next|afvis|decline)\b/i.test(msg)
          ? lastSourcingCandidate
          : undefined,
    }),
  };
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    fetchOpts.signal = AbortSignal.timeout(180000);
  }
  fetch("/api/admin/sourcing-chat", fetchOpts)
    .then((r) =>
      r.text().then((text) => {
        let j = {};
        if (text) {
          try {
            j = JSON.parse(text);
          } catch {
            j = {
              ok: false,
              error:
                "Serveren returnerede ikke JSON (HTTP " +
                r.status +
                "). " +
                (text.slice(0, 180).replace(/</g, "&lt;") || "Tomt svar") +
                (r.status === 404
                  ? " — genstart Node-serveren så POST /api/admin/sourcing-chat er indlæst."
                  : ""),
            };
          }
        } else if (!r.ok) {
          j = { ok: false, error: "HTTP " + r.status + " · tomt svar" };
        }
        return { ok: r.ok, status: r.status, j };
      })
    )
    .then((x) => {
      if (x.status === 401 && typeof window !== "undefined" && window.VeldenUnauthorized) {
        window.VeldenUnauthorized.report(messageFromAny(x.j, "Unauthorized"));
      } else if (x.ok && typeof window !== "undefined" && window.VeldenUnauthorized) {
        window.VeldenUnauthorized.noteResponseOk(true);
      }
      const body = x.j && x.j.data && typeof x.j.data === "object" ? x.j.data : x.j;
      if (!x.ok || !body || body.ok !== true) {
        const err = messageFromAny(x.j, "Forespørgsel fejlede (HTTP " + x.status + ").");
        appendSourcingChatBubble(
          "assistant",
          '<p class="adm-sc-plain adm-sc-plain--err">' + esc(err) + "</p>"
        );
        return;
      }
      const d = body;
      let bubble = '<p class="adm-sc-plain adm-sc-plain--lead">' + esc(messageFromAny(d.assistantText, "")) + "</p>";
      if (d.candidate) {
        lastSourcingCandidate = d.candidate;
        bubble += formatChatCandidateCard(d.candidate);
      }
      if (d.kind === "inserted" || d.kind === "no_candidate") {
        lastSourcingCandidate = null;
      }
      appendSourcingChatBubble("assistant", bubble);
      if (d.kind === "inserted") reloadCatalog();
    })
    .catch((err) => {
      let hint = "Kunne ikke nå serveren.";
      if (err && err.name === "TimeoutError") {
        hint = "Forespørgslen tog for lang tid (over 3 min). Prøv igen.";
      } else if (err && err.name === "AbortError") {
        hint = "Annulleret eller timeout. Prøv igen.";
      } else if (err && err.message) {
        hint = err.message;
      }
      appendSourcingChatBubble(
        "assistant",
        '<p class="adm-sc-plain adm-sc-plain--err">' + esc(hint) + "</p>"
      );
    })
    .finally(() => {
      setSourcingChatLoading(false);
      const i = document.getElementById("sourcing-chat-input");
      if (i) i.focus();
    });
}

export function wireSourcingChat(reloadCatalog) {
  const send = document.getElementById("sourcing-chat-send");
  const inp = document.getElementById("sourcing-chat-input");
  if (send) send.addEventListener("click", () => sendSourcingChatMessage(reloadCatalog));
  if (inp) {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendSourcingChatMessage(reloadCatalog);
      }
    });
  }
}
