const { GoogleGenerativeAI } = require("@google/generative-ai");
const logger = require("./logger");

function isModelNotFoundError(e) {
  const msg = String(e && (e.message || e) || "");
  return (
    /models\/.+ is not found/i.test(msg) ||
    /model.*not found/i.test(msg) ||
    /is not supported for generateContent/i.test(msg) ||
    /404.*not found/i.test(msg)
  );
}

/** gemini-1.0-pro m.fl. returnerer 404 på v1beta — brug defaults i stedet. */
function normalizedEnvModel() {
  const raw = String(process.env.GEMINI_MODEL || "").trim();
  if (!raw) return null;
  if (/^gemini-1\.0-pro$/i.test(raw) || /^gemini-1\.0-pro-latest$/i.test(raw) || /^gemini-pro$/i.test(raw)) {
    return null;
  }
  return raw;
}

function candidateModels() {
  const env = normalizedEnvModel();
  // 1.5-flash først: bredest understøttet; derefter 2.x hvis projektet har adgang.
  const fallbacks = [
    "gemini-1.5-flash",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-pro",
    "gemini-2.5-flash",
  ];
  const list = [env || null, ...fallbacks].filter(Boolean);
  return [...new Set(list)];
}

/**
 * Alle Gemini API-nøgler (primær + sekundær). Kommasepareret GEMINI_API_KEYS understøttes også.
 */
function collectGeminiApiKeys() {
  const rawList = String(process.env.GEMINI_API_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const singles = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_SECONDARY_API_KEY,
  ]
    .map((k) => String(k || "").trim())
    .filter(Boolean);
  const merged = [...rawList, ...singles];
  return [...new Set(merged)];
}

function httpStatusFromError(e) {
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : NaN);
  let s = n(e && e.status);
  if (!Number.isFinite(s)) s = n(e && e.statusCode);
  if (!Number.isFinite(s) && e && e.cause) s = n(e.cause.status) || n(e.cause.statusCode);
  return Number.isFinite(s) ? s : null;
}

/** Fejl der typisk er nøgle-/konto-/kvote- eller netværksbundne — prøv næste nøgle. */
function isTryAlternateKeyError(e) {
  const status = httpStatusFromError(e);
  if (status != null && [401, 403, 429, 500, 502, 503].includes(status)) return true;
  const msg = String(e && (e.message || e) || "").toLowerCase();
  if (
    /api.key|invalid.*key|permission|quota|resource_exhausted|exhausted|billing|unauthenticated|forbidden|too many requests|rate limit/i.test(
      msg
    )
  ) {
    return true;
  }
  if (/fetch failed|econnreset|etimedout|enotfound|socket|network|timed out/i.test(msg)) return true;
  return false;
}

/**
 * Runs generateContent with per-key and per-model fallback.
 * Returns the raw text response.
 */
async function geminiGenerateText(prompt) {
  const keys = collectGeminiApiKeys();
  if (!keys.length) {
    const err = new Error("NO_KEY");
    err.code = "NO_KEY";
    throw err;
  }

  const models = candidateModels();
  let lastErr = null;
  let keyIndex = 0;

  for (const apiKey of keys) {
    keyIndex += 1;
    const genAI = new GoogleGenerativeAI(apiKey);
    for (const modelName of models) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        return result.response.text();
      } catch (e) {
        lastErr = e;
        if (isModelNotFoundError(e)) continue;
        if (isTryAlternateKeyError(e) && keyIndex < keys.length) {
          logger.warn("gemini.fallback_key", {
            fromKeyIndex: keyIndex,
            model: modelName,
            status: httpStatusFromError(e),
            message: e && e.message ? String(e.message).slice(0, 200) : String(e).slice(0, 200),
          });
          break;
        }
        throw e;
      }
    }
  }
  throw lastErr || new Error("Gemini failed");
}

module.exports = { geminiGenerateText, collectGeminiApiKeys };

