/**
 * Konverterer scrapede kildepriser til DKK til brug som cost i Velden (pricing.js lægger offset ovenpå).
 *
 * Env:
 *   EUR_TO_DKK_RATE — default 7.46
 *   USD_TO_DKK_RATE — default 6.95
 *   GBP_TO_DKK_RATE — default 8.85
 *   DISCOVERY_UNK_HOST_CURRENCY — når siden ikke angiver valuta: EUR | DKK (default EUR for .com/.de/…; .dk behandles altid som DKK)
 */

function numEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const EUR_DKK = numEnv("EUR_TO_DKK_RATE", 7.46);
const USD_DKK = numEnv("USD_TO_DKK_RATE", 6.95);
const GBP_DKK = numEnv("GBP_TO_DKK_RATE", 8.85);

function hostLooksDanish(url) {
  try {
    return /\.dk$/i.test(new URL(url).hostname || "");
  } catch {
    return false;
  }
}

function normalizeCurrencyCode(raw) {
  const s = String(raw || "").trim();
  const u = s.toUpperCase();
  if (!s) return "";
  if (/€/.test(s) || /^EUR\b|^EURO\b/i.test(u)) return "EUR";
  if (/£/.test(s) || /^GBP\b/i.test(u)) return "GBP";
  if (/^USD\b|\bUS\$\b/i.test(u)) return "USD";
  if (/^DKK\b|^KR\.?\b/i.test(u)) return "DKK";
  if (/^SEK\b/i.test(u)) return "SEK";
  if (/^NOK\b/i.test(u)) return "NOK";
  return u.replace(/[^A-Z]/g, "").slice(0, 3);
}

/**
 * @param {number} amount — positiv talværdi fra scraper (punktum-decimal)
 * @param {string} [currencyRaw] — ISO fra schema.org / meta (EUR, USD, …)
 * @param {string} [contextUrl] — produkt-URL til fallback (.dk = DKK)
 * @returns {number} pris i DKK (2 decimaler hvor relevant)
 */
function normalizeDiscoveredPriceToDkk(amount, currencyRaw, contextUrl) {
  const n = Number(amount) || 0;
  if (n <= 0) return 0;

  let code = normalizeCurrencyCode(currencyRaw);

  if (!code) {
    if (hostLooksDanish(contextUrl)) code = "DKK";
    else {
      const unk = String(process.env.DISCOVERY_UNK_HOST_CURRENCY || "EUR")
        .trim()
        .toUpperCase();
      code = unk === "DKK" ? "DKK" : "EUR";
    }
  }

  if (code === "DKK" || code === "KR") return Math.round(n * 100) / 100;

  if (code === "EUR" || code === "EURO") return Math.round(n * EUR_DKK * 100) / 100;

  if (code === "USD" || code === "US") return Math.round(n * USD_DKK * 100) / 100;

  if (code === "GBP" || code === "UK") return Math.round(n * GBP_DKK * 100) / 100;

  if (code === "SEK") return Math.round(n * 0.64 * 100) / 100;
  if (code === "NOK") return Math.round(n * 0.63 * 100) / 100;

  return Math.round(n * 100) / 100;
}

module.exports = {
  normalizeDiscoveredPriceToDkk,
  hostLooksDanish,
};
