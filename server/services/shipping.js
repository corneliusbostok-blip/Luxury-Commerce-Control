/**
 * Stripe checkout currency + shipping (minor units = øre for DKK, cents for USD).
 */

const STRIPE_CURRENCY = String(process.env.STRIPE_CURRENCY || "dkk").toLowerCase();

/** Nordic excl. DK */
const NORDIC = new Set(["SE", "NO", "FI", "IS"]);

/** EU (incl. DK for grouping — DK handled first) */
const EU = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

function parseMajorMap(envKey, fallback) {
  try {
    const raw = process.env[envKey];
    if (!raw) return fallback;
    const j = JSON.parse(raw);
    if (j && typeof j === "object") return j;
  } catch {
    /* ignore */
  }
  return fallback;
}

/** Shipping in major units (kr / $) — override via env SHIPPING_DKK_MAJOR_JSON e.g. {"DK":49,"SE":89} */
const SHIPPING_MAJOR_DEFAULT = {
  DK: 49,
  NORDIC: 89,
  EU: 69,
  WORLD: 129,
};

const SHIPPING_MAJOR = { ...SHIPPING_MAJOR_DEFAULT, ...parseMajorMap("SHIPPING_DKK_MAJOR_JSON", {}) };

function normalizeCountry(code) {
  const c = String(code || "")
    .trim()
    .toUpperCase();
  if (c.length === 2 && /^[A-Z]{2}$/.test(c)) return c;
  return "DK";
}

function shippingMajorForCountry(code) {
  const cc = normalizeCountry(code);
  if (cc === "DK") return Number(SHIPPING_MAJOR.DK ?? SHIPPING_MAJOR_DEFAULT.DK) || 49;
  if (NORDIC.has(cc)) return Number(SHIPPING_MAJOR.NORDIC ?? SHIPPING_MAJOR_DEFAULT.NORDIC) || 89;
  if (EU.has(cc)) return Number(SHIPPING_MAJOR.EU ?? SHIPPING_MAJOR_DEFAULT.EU) || 69;
  return Number(SHIPPING_MAJOR.WORLD ?? SHIPPING_MAJOR_DEFAULT.WORLD) || 129;
}

/** DB / display price major → Stripe smallest unit */
function productAmountMinor(priceMajor) {
  const p = Number(priceMajor) || 0;
  if (STRIPE_CURRENCY === "jpy") return Math.max(1, Math.round(p));
  return Math.max(100, Math.round(p * 100));
}

function shippingAmountMinor(countryCode) {
  const major = shippingMajorForCountry(countryCode);
  if (STRIPE_CURRENCY === "jpy") return Math.max(0, Math.round(major));
  return Math.max(0, Math.round(major * 100));
}

function minLineAmountMinor() {
  if (STRIPE_CURRENCY === "jpy") return 50;
  if (STRIPE_CURRENCY === "dkk") return 2500;
  return 50;
}

const COUNTRY_OPTIONS = [
  { code: "DK", name: "Danmark" },
  { code: "SE", name: "Sverige" },
  { code: "NO", name: "Norge" },
  { code: "FI", name: "Finland" },
  { code: "DE", name: "Tyskland" },
  { code: "NL", name: "Holland" },
  { code: "FR", name: "Frankrig" },
  { code: "IT", name: "Italien" },
  { code: "ES", name: "Spanien" },
  { code: "PL", name: "Polen" },
  { code: "AT", name: "Østrig" },
  { code: "BE", name: "Belgien" },
  { code: "CH", name: "Schweiz" },
  { code: "GB", name: "Storbritannien" },
  { code: "US", name: "USA" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australien" },
];

function listShippingOptions() {
  return COUNTRY_OPTIONS.map(({ code, name }) => ({
    code,
    name,
    amountMajor: shippingMajorForCountry(code),
  }));
}

const ALLOWED_SHIP_CODES = new Set(COUNTRY_OPTIONS.map((c) => c.code));

function isAllowedShippingCountry(code) {
  return ALLOWED_SHIP_CODES.has(normalizeCountry(code));
}

module.exports = {
  STRIPE_CURRENCY,
  normalizeCountry,
  shippingMajorForCountry,
  shippingAmountMinor,
  productAmountMinor,
  minLineAmountMinor,
  listShippingOptions,
  isAllowedShippingCountry,
};
