/**
 * Shop price = source cost + fixed offset (default 200–300 in same unit as cost, typically DKK).
 * Override with VELDEN_PRICE_OFFSET_MIN / VELDEN_PRICE_OFFSET_MAX and VELDEN_PRICE_MIN.
 */

const OFFSET_MIN = Math.max(0, Number(process.env.VELDEN_PRICE_OFFSET_MIN) || 200);
const OFFSET_MAX = Math.max(OFFSET_MIN, Number(process.env.VELDEN_PRICE_OFFSET_MAX) || 300);
const MIN_RETAIL = Math.max(0, Number(process.env.VELDEN_PRICE_MIN) || 99);

function randomIntInclusive(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

function offsetFromKey(stableKey) {
  const s = String(stableKey || "velden");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const span = OFFSET_MAX - OFFSET_MIN + 1;
  return OFFSET_MIN + ((h >>> 0) % span);
}

function resolveConfig(productOrConfig, configMaybe) {
  const looksConfig =
    productOrConfig &&
    typeof productOrConfig === "object" &&
    (Object.prototype.hasOwnProperty.call(productOrConfig, "targetMargin") ||
      Object.prototype.hasOwnProperty.call(productOrConfig, "priceRange"));
  if (looksConfig) return productOrConfig || {};
  return configMaybe || {};
}

function demandMultiplier(product) {
  const p = product || {};
  const orders = Number(p.orders_count) || 0;
  const views = Number(p.views) || 0;
  const velocity = views > 0 ? orders / views : orders > 0 ? 0.2 : 0;
  if (orders >= 15 || velocity >= 0.12) return 1.12;
  if (orders >= 6 || velocity >= 0.07) return 1.06;
  if (orders <= 0 && views >= 80) return 0.94;
  if (orders <= 1 && views >= 30) return 0.97;
  return 1;
}

function priceFromCost(cost, product, configMaybe) {
  const cfg = resolveConfig(product, configMaybe);
  const c = Number(cost) || 0;
  const targetMargin = Number(cfg.targetMargin);
  const marginPrice =
    Number.isFinite(targetMargin) && targetMargin > 0 && targetMargin < 0.95
      ? c / Math.max(0.05, 1 - targetMargin)
      : c + randomIntInclusive(OFFSET_MIN, OFFSET_MAX);
  const raw = marginPrice * demandMultiplier(product);
  const minCfg = Number(cfg.priceRange && cfg.priceRange.min);
  const maxCfg = Number(cfg.priceRange && cfg.priceRange.max);
  const minP = Number.isFinite(minCfg) ? Math.max(MIN_RETAIL, minCfg) : MIN_RETAIL;
  const maxP = Number.isFinite(maxCfg) && maxCfg > 0 ? maxCfg : Number.POSITIVE_INFINITY;
  return Math.round(Math.min(maxP, Math.max(minP, raw)));
}

/** Same logic as priceFromCost but stable per key (chat preview = DB insert). */
function priceFromCostDeterministic(cost, stableKey, product, configMaybe) {
  const cfg = resolveConfig(product, configMaybe);
  const c = Number(cost) || 0;
  const targetMargin = Number(cfg.targetMargin);
  const marginPrice =
    Number.isFinite(targetMargin) && targetMargin > 0 && targetMargin < 0.95
      ? c / Math.max(0.05, 1 - targetMargin)
      : c + offsetFromKey(stableKey);
  const raw = marginPrice * demandMultiplier(product);
  const minCfg = Number(cfg.priceRange && cfg.priceRange.min);
  const maxCfg = Number(cfg.priceRange && cfg.priceRange.max);
  const minP = Number.isFinite(minCfg) ? Math.max(MIN_RETAIL, minCfg) : MIN_RETAIL;
  const maxP = Number.isFinite(maxCfg) && maxCfg > 0 ? maxCfg : Number.POSITIVE_INFINITY;
  return Math.round(Math.min(maxP, Math.max(minP, raw)));
}

/** @deprecated kept for any external require */
function charmRound(n) {
  return Math.round(Number(n) || 0);
}

function randomMarkup() {
  return 1;
}

module.exports = {
  priceFromCost,
  priceFromCostDeterministic,
  demandMultiplier,
  charmRound,
  randomMarkup,
};
