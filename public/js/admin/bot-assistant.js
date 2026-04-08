import { adminHeaders } from "./utils.js";
import { ensureSourcingChatSessionId } from "./sourcing-chat.js";

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let recognition = null;
let listening = false;
let talkTimer = null;
let keepListening = false;
let noSpeechRetries = 0;
const MAX_NO_SPEECH_RETRIES = 6;
let sessionMaxTimeout = null;
let silenceTimer = null;
const SILENCE_AFTER_MS = 1600;
let finalTranscriptBuf = "";
let lastLiveTranscript = "";
let lastSpeechError = "";
let geminiAudioEl = null;

function normalizeText(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function wantsSourcing(message) {
  const m = normalizeText(message);
  return (
    /^(find|vis mig|sog efter|sog|giv mig|show me|find me)\s/.test(m) ||
    /(sko|skjorte|shirts?|polos?|bukser|trousers?|outerwear|ur|watches?|tilbehor|accessories)/.test(m) ||
    /^(ja|nej|yes|no)\b/.test(m)
  );
}

function wantsLastLog(message) {
  const m = normalizeText(message);
  return /(sidste|seneste)\s+log/.test(m) || /last\s+log/.test(m) || /(hvad er log|hvad star i log)/.test(m);
}

function wantsStoreStatus(message) {
  const m = normalizeText(message);
  return /(hvordan.*butik|status.*butik|gar det med butik|how.*shop|status.*shop)/.test(m);
}

function wantsLastSourcing(message) {
  const m = normalizeText(message);
  return /(sidst.*hentet|seneste.*hentet|sidst.*sourcing|last.*sourcing)/.test(m);
}

function setListeningUi(on) {
  const face = document.getElementById("ai-face");
  const tip = document.getElementById("ai-face-tooltip");
  if (!face) return;
  face.setAttribute("aria-pressed", on ? "true" : "false");
  if (tip) tip.textContent = on ? "Lytter... klik igen for stop" : "Klik for at tale";
}

function clearSilenceTimer() {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
}

function armSilenceCommit(reloadCatalog) {
  clearSilenceTimer();
  silenceTimer = setTimeout(() => {
    silenceTimer = null;
    const fromFinal = finalTranscriptBuf.trim();
    const fromLive = lastLiveTranscript.trim();
    const text = fromFinal || fromLive;
    if (!text || !keepListening) return;
    keepListening = false;
    noSpeechRetries = 0;
    lastSpeechError = "";
    stopListening();
    askAssistant(text, reloadCatalog);
  }, SILENCE_AFTER_MS);
}

function startListening() {
  if (!recognition) return;
  finalTranscriptBuf = "";
  lastLiveTranscript = "";
  clearSilenceTimer();
  keepListening = true;
  listening = true;
  setListeningUi(true);
  showSpeechBubble("Jeg lytter... tal nu (pause når du er færdig).");
  const tryStart = (delayMs) => {
    window.setTimeout(() => {
      if (!keepListening || !recognition) return;
      try {
        recognition.start();
      } catch {
        window.setTimeout(() => {
          if (!keepListening || !recognition) return;
          try {
            recognition.start();
          } catch {
            keepListening = false;
            listening = false;
            setListeningUi(false);
            const msg = `Stemme lyttelse kunne ikke startes${lastSpeechError ? " (" + lastSpeechError + ")" : ""}. Prøv Chrome eller tillad mikrofon.`;
            showSpeechBubble(msg);
            void speakAssistant(msg);
          }
        }, 120);
      }
    }, delayMs);
  };
  tryStart(180);
}

function stopListening() {
  keepListening = false;
  listening = false;
  setListeningUi(false);
  clearSilenceTimer();
  if (sessionMaxTimeout) {
    clearTimeout(sessionMaxTimeout);
    sessionMaxTimeout = null;
  }
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* ignore */
    }
  }
}

async function ensureMicPermission() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch (e) {
    const code = String((e && (e.name || e.message)) || "").toLowerCase();
    let msg = "Mikrofon er ikke tilgængelig.";
    if (code.includes("notallowed") || code.includes("permission")) {
      msg = "Mikrofon er blokeret. Tillad mikrofon for localhost i browseren.";
    } else if (code.includes("notfound") || code.includes("devicesnotfound")) {
      msg = "Ingen mikrofon fundet på enheden.";
    }
    showSpeechBubble(msg);
    void speakAssistant(msg);
    return false;
  }
}

function createRecognition(reloadCatalog) {
  const rec = new SpeechRecognition();
  rec.lang = "da-DK";
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.continuous = true;
  rec.onstart = () => {
    listening = true;
    setListeningUi(true);
  };
  rec.onresult = (e) => {
    if (!e.results || !e.results.length) return;
    let interim = "";
    for (let i = e.resultIndex || 0; i < e.results.length; i += 1) {
      const r = e.results[i];
      if (!r || !r[0]) continue;
      const t = String(r[0].transcript || "");
      if (r.isFinal) {
        finalTranscriptBuf = (finalTranscriptBuf + " " + t).replace(/\s+/g, " ").trim();
      } else {
        interim += t;
      }
    }
    const base = finalTranscriptBuf.trim();
    const live = interim.replace(/\s+/g, " ").trim();
    lastLiveTranscript = live ? (base ? base + " " + live : live) : base;
    armSilenceCommit(reloadCatalog);
  };
  rec.onerror = (e) => {
    const code = String((e && e.error) || "").toLowerCase();
    lastSpeechError = code || "fejl";
    if (keepListening && (code === "no-speech" || code === "aborted") && noSpeechRetries < MAX_NO_SPEECH_RETRIES) {
      noSpeechRetries += 1;
      showSpeechBubble(`Intet hørt endnu — lytter videre… (${noSpeechRetries}/${MAX_NO_SPEECH_RETRIES})`);
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      return;
    }
    keepListening = false;
    noSpeechRetries = 0;
    stopListening();
    let msg = `Jeg kunne ikke høre dig (fejl: ${code || "ukendt"}). Prøv igen eller brug Chrome.`;
    if (code === "not-allowed" || code === "service-not-allowed") {
      msg = "Mikrofon er blokeret. Tillad mikrofon for dette site i browseren.";
    } else if (code === "audio-capture") {
      msg = "Ingen lyd fra mikrofon. Tjek input og site-indstillinger.";
    } else if (code === "network") {
      msg = "Stemmetjeneste kræver net — tjek forbindelse.";
    }
    showSpeechBubble(msg);
    void speakAssistant(msg);
  };
  rec.onend = () => {
    if (keepListening && noSpeechRetries <= MAX_NO_SPEECH_RETRIES) {
      window.setTimeout(() => {
        if (!keepListening || !rec) return;
        try {
          rec.start();
        } catch {
          window.setTimeout(() => {
            if (!keepListening || !rec) return;
            try {
              rec.start();
            } catch {
              /* stopListening kaldes fra onerror eller ved klik */
            }
          }, 160);
        }
      }, 80);
      return;
    }
    if (!keepListening) return;
    stopListening();
  };
  return rec;
}

function showSpeechBubble(text) {
  const face = document.getElementById("ai-face");
  const stack = document.getElementById("ai-face-bubble-stack");
  if (!face || !stack) return;
  const msg = String(text || "").trim();
  if (!msg) return;
  stack.innerHTML = '<p class="adm-bubble-line adm-bubble-line--new">' + msg.replace(/</g, "&lt;") + "</p>";
  face.classList.add("adm-ai-face--talk");
  if (talkTimer) clearTimeout(talkTimer);
  talkTimer = setTimeout(() => {
    face.classList.remove("adm-ai-face--talk");
  }, 7000);
}

function speakBrowserTts(msg) {
  const t = String(msg || "").trim();
  if (!t || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t);
    u.lang = "da-DK";
    u.rate = 1;
    u.pitch = 1;
    window.speechSynthesis.speak(u);
  } catch {
    /* ignore */
  }
}

/** Taler med Gemini-stemme via server; falder tilbage til browser-TTS ved fejl. */
async function speakAssistant(text) {
  const msg = String(text || "").trim();
  if (!msg) return;
  if (geminiAudioEl) {
    try {
      geminiAudioEl.pause();
      geminiAudioEl.removeAttribute("src");
    } catch {
      /* ignore */
    }
    geminiAudioEl = null;
  }
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
  try {
    const fetchOpts = {
      method: "POST",
      headers: adminHeaders(),
      credentials: "include",
      body: JSON.stringify({ text: msg }),
    };
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
      fetchOpts.signal = AbortSignal.timeout(120000);
    }
    const r = await fetch("/api/admin/bot-tts", fetchOpts);
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (r.ok && ct.includes("audio")) {
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio();
      geminiAudioEl = audio;
      audio.src = url;
      const cleanup = () => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
        if (geminiAudioEl === audio) geminiAudioEl = null;
      };
      audio.addEventListener("ended", cleanup, { once: true });
      audio.addEventListener("error", cleanup, { once: true });
      await audio.play();
      return;
    }
  } catch {
    /* Gemini TTS utilgængelig */
  }
  speakBrowserTts(msg);
}

async function postJson(url, payload) {
  const opts = {
    method: "POST",
    headers: adminHeaders(),
    credentials: "include",
    body: JSON.stringify(payload),
  };
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    opts.signal = AbortSignal.timeout(180000);
  }
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: false, error: "Ugyldigt svar fra server (HTTP " + r.status + ")." };
    }
  }
  const body = data && data.data && typeof data.data === "object" ? data.data : data;
  return { ok: r.ok && body && body.ok === true, status: r.status, body };
}

async function fallbackAssistant(message, sessionId) {
  if (wantsSourcing(message)) {
    return postJson("/api/admin/sourcing-chat", { sessionId, message });
  }
  if (wantsLastLog(message)) {
    const r = await fetch("/api/admin/ai-feed", { headers: adminHeaders({ json: false }), credentials: "include" });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data && data.ok && Array.isArray(data.feed)) {
      const rows = data.feed.slice(0, 3);
      const txt = rows.length
        ? "Seneste log er: " + (rows[0].message || rows[0].action || "ukendt")
        : "AI-log er tom lige nu.";
      return { ok: true, status: 200, body: { ok: true, assistantText: txt } };
    }
  }
  if (wantsStoreStatus(message) || wantsLastSourcing(message)) {
    const r = await fetch("/api/admin/summary", { headers: adminHeaders({ json: false }), credentials: "include" });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data && data.ok) {
      const ai = data.ai || {};
      const txt = wantsLastSourcing(message)
        ? `Sourcing sidst: ${ai.sourcingLastRunAt || "—"} og indsat ${ai.sourcingLastInserted || 0}.`
        : `Butik status: CEO er ${ai.ceoPaused ? "på pause" : "aktiv"}, og sidste run var ${ai.lastRunAt || "ukendt"}.`;
      return { ok: true, status: 200, body: { ok: true, assistantText: txt } };
    }
  }
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      assistantText: "Sig fx: hvad er sidste log, hvordan går det med butikken, hvad har du sidst hentet, eller find sko.",
    },
  };
}

async function askAssistant(message, reloadCatalog) {
  const msg = String(message || "").trim();
  if (!msg) return;
  const sessionId = ensureSourcingChatSessionId();
  let resp = await postJson("/api/admin/bot-assistant", { sessionId, message: msg });
  if (!resp.ok && (resp.status === 404 || resp.status === 0 || resp.status >= 500)) {
    resp = await fallbackAssistant(msg, sessionId);
  }
  const body = resp.body || {};
  const text = String(body.assistantText || body.message || body.error || "Jeg kunne ikke svare lige nu.");
  showSpeechBubble(text);
  await speakAssistant(text);
  if (body.kind === "inserted" && typeof reloadCatalog === "function") reloadCatalog();
}

export function initBotAssistant(reloadCatalog) {
  const face = document.getElementById("ai-face");
  if (!face) return;

  face.addEventListener("click", async () => {
    if (!SpeechRecognition) {
      const msg = "Din browser understøtter ikke stemmeinput her.";
      showSpeechBubble(msg);
      await speakAssistant(msg);
      return;
    }
    if (listening || keepListening) {
      stopListening();
      return;
    }
    const ok = await ensureMicPermission();
    if (!ok) return;
    if (!recognition) recognition = createRecognition(reloadCatalog);
    noSpeechRetries = 0;
    lastSpeechError = "";
    startListening();
    sessionMaxTimeout = setTimeout(() => {
      if (!listening && !keepListening) return;
      const text = (finalTranscriptBuf.trim() || lastLiveTranscript.trim());
      stopListening();
      if (text) {
        askAssistant(text, reloadCatalog);
        return;
      }
      const msg =
        "Tidsgrænse uden tale. Klik igen, tillad mikrofon, og tal straks — eller brug Google Chrome.";
      showSpeechBubble(lastSpeechError ? msg + " (" + lastSpeechError + ")" : msg);
      void speakAssistant(msg);
    }, 45000);
  });
}
