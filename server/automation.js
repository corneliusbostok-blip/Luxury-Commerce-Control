/**
 * Continuous automation loop: sync scores → CEO (Gemini) plan → apply removes/scale/prices → discover & insert
 * products → regenerate marketing content → AiMemory + AiLog. Runs on server start + setInterval.
 */
const { decideWithGemini, performanceScore } = require("./ai/brain");
const { randomUUID } = require("crypto");
const { discoverProducts, discoverProductsDetailed } = require("./services/discovery");
const { priceFromCost, priceFromCostDeterministic } = require("./services/pricing");
const { computeOptimalPrice } = require("./services/pricing/price-engine");
const { generateProductCopy, generateSocialPack } = require("./services/content");
const { inferCategory, inferProductColor, normalizeCategoryId } = require("./services/category");
const { evaluateVeldenSourcing } = require("./services/sourcing");
const {
  canonicalProductName,
  styleKeyFromTitle,
  parseColorVariants,
  loadExternalIdSet,
  findStyleMergeRow,
} = require("./services/variants");
const { visibleOnShopfront } = require("./db/supabase");
const {
  loadSourcingUserRejects,
  candidateBlockedByUserMemory,
} = require("./services/sourcing-memory");
const { enforceBusinessRules, enforceRiskCapsOnPlan } = require("./services/policy");
const { canInsertCategory, categoryRankPenalty } = require("./services/policy");
const { acquireLock, releaseLock } = require("./services/automation-lock");
const { logProductTransition } = require("./services/product-state");
const { computeStoreMetrics } = require("./services/business-metrics");
const { recordDailyMetrics, getLastNDaysTrends } = require("./services/trends");
const { recordLearningMetrics } = require("./services/learning-observability");
const { adjustPricesForAOV } = require("./services/pricing-strategy");
const { snapshotProducts, restoreProducts } = require("./services/rollback");
const { assignVariant } = require("./services/experiments");
const { evaluateExperimentResults } = require("./services/experiment-evaluator");
const { updateSourceMetrics, loadSourceMetricsMap, sourceDiscoveryWeight } = require("./services/source-feedback");
const { computeObjective, evaluateDelta } = require("./services/objective");
const { computeStrategyState } = require("./services/strategy");
const {
  recordPriceElasticityChange,
  backfillElasticityOutcomes,
  elasticityMultiplierForCategory,
} = require("./services/price-elasticity");
const { inferIntentCategory, generateCategoryQueryPack } = require("./services/sourcing/query-engine");
const { matchesTrendText } = require("./services/trends/trend-engine");
const { tuneParametersFromTrends } = require("./services/self-tuning");
const { getStoreConfig } = require("./config/store-config");
const { loadRiskAdaptMultiplier, persistRiskAdaptation, computeNextAdaptation } = require("./services/risk-adaptation");
const { recordDecision, loadRecentDecisions } = require("./services/decision-ledger");
const { attributeCycleOutcome, computeDecisionQualityScore } = require("./services/outcome-attribution");
const {
  startExperiment,
  shouldCloseExperiment,
  closeExperiment,
  archiveExperimentResult,
} = require("./services/experiment-lifecycle");
const { rebuildCategoryLearning, loadCategoryLearningMap } = require("./services/category-learning");
const logger = require("./lib/logger");
const { computeProductRankScore } = require("./services/ranking/engine");
const { decideAutoApproval } = require("./services/sourcing-service/auto-approval");
const {
  estimateRiskScore,
  enrichSeoForSourcing,
  computeMerchScore,
  combineAiWithPopularity,
  evaluatePriceSanity,
} = require("./services/ai-service/merch-ai");
const { computePopularityScore } = require("./services/sourcing/popularity-score");
const { computeConfidenceScore } = require("./services/sourcing/confidence-score");
const { getLearningMemory } = require("./services/learning/memory");
const { publishEvent } = require("./services/events/bus");
const { EVENTS } = require("./services/events/contracts");
const { createSourcingCandidate } = require("./services/sourcing-candidates");
const {
  normalizeImages,
  normalizeVariants,
  summarizeSizesFromVariants,
  inferPrimaryColorFromVariants,
  hasAvailableVariant,
} = require("./services/product-sync-normalizer");
const AUTOMATION_RUNTIME_VERSION = "v2-delegated-execution";
console.log("AUTOMATION VERSION:", AUTOMATION_RUNTIME_VERSION);

const CEO_INTERVAL_MS = Math.max(30_000, Number(process.env.CEO_INTERVAL_MS) || 5 * 60 * 1000);

const DEFAULT_SOURCING_INTERVAL_MS = 10 * 60 * 1000;

function resolveSourcingIntervalMs() {
  const minFromEnv = Number(process.env.SOURCING_INTERVAL_MINUTES);
  if (Number.isFinite(minFromEnv) && minFromEnv > 0) {
    return Math.max(60_000, Math.round(minFromEnv * 60 * 1000));
  }
  const rawMs = process.env.SOURCING_INTERVAL_MS;
  const n = rawMs != null && String(rawMs).trim() !== "" ? Number(rawMs) : NaN;
  const ms = Number.isFinite(n) && n > 0 ? n : DEFAULT_SOURCING_INTERVAL_MS;
  return Math.max(60_000, ms);
}

/** Continuous product discovery + import (no CEO plan). Default 10 min — override via SOURCING_INTERVAL_MINUTES or SOURCING_INTERVAL_MS. */
const SOURCING_INTERVAL_MS = resolveSourcingIntervalMs();
const SOURCING_BATCH_SIZE = Math.min(
  6,
  Math.max(1, Number(process.env.SOURCING_BATCH_SIZE) || 2)
);
const SOURCING_DISABLED = /^1|true|yes$/i.test(String(process.env.SOURCING_DISABLED || ""));
/** Når sand: ingen løbende CEO-cyklus (scores, Gemini, discovery, pris/content). */
let ceoAutomationPaused = /^1|true|yes$/i.test(String(process.env.CEO_AUTOMATION_DISABLED || ""));
const MAX_ACTIONS_PER_CYCLE = Math.max(1, Number(process.env.CEO_MAX_ACTIONS_PER_CYCLE) || 10);
const MAX_DEACTIVATE_ACTIONS_PER_CYCLE = Math.max(0, Number(process.env.CEO_MAX_DEACTIVATE_ACTIONS_PER_CYCLE) || 1);
const MAX_SCALE_ACTIONS_PER_CYCLE = Math.max(0, Number(process.env.CEO_MAX_SCALE_ACTIONS_PER_CYCLE) || 4);
const MAX_PRICE_ACTIONS_PER_CYCLE = Math.max(0, Number(process.env.CEO_MAX_PRICE_ACTIONS_PER_CYCLE) || 5);
const CEO_ERROR_STREAK_LIMIT = Math.max(1, Number(process.env.CEO_CIRCUIT_BREAKER_ERROR_STREAK) || 3);
const DEFAULT_TARGET_ACTIVE_PRODUCTS = Math.max(1, Number(process.env.CEO_TARGET_ACTIVE_PRODUCTS) || 100);
const DEFAULT_TARGET_MAX_INACTIVE = Math.max(0, Number(process.env.CEO_TARGET_MAX_INACTIVE) || 5);
const ALLOWED_ACTIONS = ["create", "update", "deactivate"];

const NO_PRODUCTS_REASON = {
  DB_UNAVAILABLE: "db_unavailable",
  PROVIDER_OFF: "provider_off",
  AUTOMATION_PAUSED: "automation_paused",
  AUTOMATION_BUSY: "automation_busy",
  SOURCING_BUSY: "sourcing_busy",
  LOCK_BUSY: "lock_busy",
  AT_CAPACITY: "at_capacity",
  AUTO_IMPORT_DISABLED: "auto_import_disabled",
  NO_SEED: "no_seed",
  FILTERED_OUT: "filtered_out",
  UNKNOWN: "unknown",
};

function noProductsReasonMessage(code) {
  const c = String(code || NO_PRODUCTS_REASON.UNKNOWN);
  const map = {
    [NO_PRODUCTS_REASON.DB_UNAVAILABLE]: "Database unavailable",
    [NO_PRODUCTS_REASON.PROVIDER_OFF]: "No active providers enabled",
    [NO_PRODUCTS_REASON.AUTOMATION_PAUSED]: "Automation is paused",
    [NO_PRODUCTS_REASON.AUTOMATION_BUSY]: "Automation cycle is busy",
    [NO_PRODUCTS_REASON.SOURCING_BUSY]: "Sourcing pass is already running",
    [NO_PRODUCTS_REASON.LOCK_BUSY]: "Sourcing lock is busy",
    [NO_PRODUCTS_REASON.AT_CAPACITY]: "Catalog already at max capacity",
    [NO_PRODUCTS_REASON.AUTO_IMPORT_DISABLED]: "Automatic import is disabled",
    [NO_PRODUCTS_REASON.NO_SEED]: "No discovery seed URLs configured",
    [NO_PRODUCTS_REASON.FILTERED_OUT]: "Candidates were filtered out by rules",
    [NO_PRODUCTS_REASON.UNKNOWN]: "No candidates found",
  };
  return map[c] || map[NO_PRODUCTS_REASON.UNKNOWN];
}

function setCeoAutomationPaused(paused) {
  ceoAutomationPaused = Boolean(paused);
}

function isCeoAutomationPaused() {
  return ceoAutomationPaused;
}

/** Godkendt / aktiv katalog — samme filter som import-loops og webshop. */
function countShopfrontCatalogProducts(products) {
  return (products || []).filter(
    (p) =>
      p.status !== "removed" &&
      p.status !== "inactive" &&
      (p.sourcing_status === "approved" || p.sourcing_status == null || p.sourcing_status === "")
  ).length;
}

function balancedPickByCategory(candidates, count, maxCategoryShare = 0.5) {
  const limit = Math.max(1, Math.floor(Number(count) || 0));
  const perCatMax = Math.max(1, Math.ceil(limit * Math.min(0.8, Math.max(0.25, Number(maxCategoryShare) || 0.5))));
  const selected = [];
  const catCounts = new Map();
  const pool = [...(candidates || [])];
  for (const item of pool) {
    if (selected.length >= limit) break;
    const cat = normalizeCategoryId(item?.evalResult?.category || item?.raw?.category || "other");
    const used = catCounts.get(cat) || 0;
    if (used >= perCatMax) continue;
    selected.push(item);
    catCounts.set(cat, used + 1);
  }
  if (selected.length < limit) {
    for (const item of pool) {
      if (selected.length >= limit) break;
      if (selected.includes(item)) continue;
      selected.push(item);
    }
  }
  return selected;
}

function explainDryRunCandidate({ row, rank, goal, riskLevel, vibeKeywords }) {
  const vibe = (vibeKeywords || []).slice(0, 2).join(", ");
  const parts = [];
  parts.push(`Fits goal=${goal} with score ${Number(rank || 0).toFixed(1)}`);
  if (vibe) parts.push(`matches vibe (${vibe})`);
  parts.push(`risk profile ${riskLevel}`);
  parts.push(`category ${normalizeCategoryId(row.category || "other")}`);
  return parts.join(" | ");
}

function popularityReason(level, ai, pop) {
  if (level === "high") return `High marketplace demand (ai ${ai.toFixed(1)}, popularity ${pop.toFixed(1)})`;
  if (level === "medium") return `Medium demand, accepted with strong AI fit (ai ${ai.toFixed(1)}, popularity ${pop.toFixed(1)})`;
  if (level === "low") return "Low marketplace demand";
  return `Marketplace demand unknown; fallback to AI (${ai.toFixed(1)})`;
}

function categoryAveragePriceMap(products) {
  const m = new Map();
  const sums = new Map();
  const cnts = new Map();
  for (const p of products || []) {
    const cat = normalizeCategoryId(p.category || "other");
    const price = Number(p.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    sums.set(cat, (sums.get(cat) || 0) + price);
    cnts.set(cat, (cnts.get(cat) || 0) + 1);
  }
  for (const [cat, sum] of sums.entries()) {
    const c = cnts.get(cat) || 1;
    m.set(cat, sum / c);
  }
  return m;
}

function estimateShippingCost(row = {}, storeConfig = null) {
  const cost = Number(row.cost ?? row.supplier_price ?? row.price) || 0;
  const base = Math.max(8, Number(process.env.DEFAULT_ESTIMATED_SHIPPING_COST) || 24);
  const category = normalizeCategoryId(row.category || "other");
  const categoryMul = category === "outerwear" ? 1.45 : category === "watches" ? 1.2 : 1;
  const cfgMul =
    storeConfig && Number(storeConfig.shippingCostMultiplier)
      ? Math.max(0.5, Math.min(3, Number(storeConfig.shippingCostMultiplier)))
      : 1;
  return Number((base * categoryMul * cfgMul + Math.max(0, cost * 0.03)).toFixed(2));
}

function estimateReturnRiskProxy(row = {}) {
  const category = normalizeCategoryId(row.category || "other");
  const sizeSensitive =
    category === "shirts" || category === "trousers" || category === "outerwear" || category === "shoes";
  return Number((sizeSensitive ? 3.5 : 1.4).toFixed(2));
}

function computeUnitProfitSnapshot(row = {}, storeConfig = null) {
  const price = Number(row.price) || 0;
  const cost = Number(row.cost) || 0;
  const shipping = Number(row.estimated_shipping_cost) || estimateShippingCost(row, storeConfig);
  const returnRisk = Number(row.return_risk_proxy) || estimateReturnRiskProxy(row);
  const unitProfit = Number((price - cost - shipping - returnRisk).toFixed(2));
  const marginPct = price > 0 ? Number((((price - cost) / price) * 100).toFixed(2)) : 0;
  return {
    estimated_shipping_cost: shipping,
    return_risk_proxy: returnRisk,
    unit_profit: unitProfit,
    margin_pct: marginPct,
  };
}

/**
 * Antal nye produkter automation må forsøge at importere i én kørsel.
 * @param {number} cap 0 = ingen øvre grænse (som før inden indstillingen fandtes).
 */
function desiredNewImportCount(activeCount, aiAddCount, cap) {
  const aiWant = Math.max(0, Math.floor(Number(aiAddCount) || 0));
  const c = Math.floor(Number(cap) || 0);
  if (c <= 0) {
    const bootstrap = activeCount < 3 ? 3 - activeCount : 0;
    return Math.max(aiWant, bootstrap);
  }
  const room = Math.max(0, c - activeCount);
  if (room <= 0) return 0;
  const minBoot = Math.min(3, c);
  const bootstrap = activeCount < minBoot ? minBoot - activeCount : 0;
  return Math.min(room, Math.max(aiWant, bootstrap));
}

/** AI CEO worker modes — must match ai-ceo/controller + admin API. */
function normalizeCeoCycleMode(mode) {
  return String(mode || "full").toLowerCase() === "light" ? "light" : "full";
}

/** Maps store_config.strategy.goal into the CEO prompt objective string. */
function mapStoreStrategyToCeoObjective(storeConfig) {
  const strategy =
    storeConfig && storeConfig.strategy && typeof storeConfig.strategy === "object" ? storeConfig.strategy : {};
  const g = String(strategy.goal || "maximize_profit").toLowerCase();
  if (g.includes("balanced")) return "balance_profit_and_growth";
  if (g.includes("growth")) return "maximize_growth_and_revenue";
  return "maximize_profit";
}

const state = {
  lastRunAt: null,
  lastError: null,
  running: false,
  lastPlan: null,
  productsAddedLastRun: 0,
  productsRemovedLastRun: 0,
  decisionsLastRun: [],
  performanceSummary: null,
  sourcingRunning: false,
  sourcingLastRunAt: null,
  sourcingLastInserted: 0,
  sourcingLastError: null,
  sourcingIntervalMs: SOURCING_INTERVAL_MS,
  sourcingLastDiscovery: null,
  fallbackPolicy: { minMarginPct: 10, minScore: 40 },
  circuitBreaker: {
    tripped: false,
    reason: null,
    trippedAt: null,
    errorStreak: 0,
    lastResetAt: null,
  },
};

function getAutomationState() {
  return {
    ...state,
    ceoAutomationPaused: isCeoAutomationPaused(),
    nextIntervalMs: CEO_INTERVAL_MS,
    sourcingIntervalMs: SOURCING_INTERVAL_MS,
    sourcingBatchSize: SOURCING_BATCH_SIZE,
    sourcingLastDiscovery: state.sourcingLastDiscovery,
    fallbackPolicy: state.fallbackPolicy,
    hardLimits: {
      maxActionsPerCycle: MAX_ACTIONS_PER_CYCLE,
      maxDeactivateActionsPerCycle: MAX_DEACTIVATE_ACTIONS_PER_CYCLE,
      maxScaleActionsPerCycle: MAX_SCALE_ACTIONS_PER_CYCLE,
      maxPriceActionsPerCycle: MAX_PRICE_ACTIONS_PER_CYCLE,
    },
    circuitBreaker: state.circuitBreaker,
  };
}

function resetAutomationCircuitBreaker() {
  state.circuitBreaker = {
    tripped: false,
    reason: null,
    trippedAt: null,
    errorStreak: 0,
    lastResetAt: new Date().toISOString(),
  };
}

function deterministicUniqueSortedIds(values) {
  return [...new Set((values || []).filter(Boolean).map((v) => String(v)))].sort((a, b) => a.localeCompare(b));
}

function deterministicPriceAdjustments(adjustments) {
  const map = new Map();
  for (const adj of adjustments || []) {
    if (!adj || !adj.id || adj.newPrice == null) continue;
    const id = String(adj.id);
    const price = Number(adj.newPrice);
    if (!Number.isFinite(price) || price <= 0) continue;
    map.set(id, price);
  }
  return [...map.entries()]
    .map(([id, newPrice]) => ({ id, newPrice }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function createDeterministicPlan(plan) {
  const removeProductIds = deterministicUniqueSortedIds(plan && plan.removeProductIds);
  const scaleProductIds = deterministicUniqueSortedIds(plan && plan.scaleProductIds);
  const contentProductIds = deterministicUniqueSortedIds(plan && plan.contentProductIds);
  const promoteProductIds = deterministicUniqueSortedIds(plan && plan.promoteProductIds);
  const priceUpdates = deterministicPriceAdjustments(plan && (plan.priceUpdates || plan.priceAdjustments));
  const addProducts = Math.max(0, Math.floor(Number(plan && plan.addProducts) || 0));
  const contentTargets = Math.max(0, Math.floor(Number(plan && plan.contentTargets) || 0));
  return {
    ...(plan || {}),
    removeProductIds,
    scaleProductIds,
    contentProductIds,
    promoteProductIds,
    priceUpdates,
    priceAdjustments: priceUpdates,
    addProducts,
    contentTargets,
    insights: Array.isArray(plan && plan.insights) ? plan.insights : [],
  };
}

function filterUnsafeActions(plan, productsById) {
  const violations = [];
  const removeProductIds = deterministicUniqueSortedIds(plan && plan.removeProductIds);
  const scaleProductIds = deterministicUniqueSortedIds(plan && plan.scaleProductIds);
  const priceUpdates = deterministicPriceAdjustments(plan && (plan.priceUpdates || plan.priceAdjustments));
  const contentProductIds = deterministicUniqueSortedIds(plan && plan.contentProductIds);
  const promoteProductIds = deterministicUniqueSortedIds(plan && plan.promoteProductIds);
  const filtered = {
    ...createDeterministicPlan(plan),
    removeProductIds,
    scaleProductIds,
    priceUpdates,
    priceAdjustments: priceUpdates,
    contentProductIds,
    promoteProductIds,
  };
  for (const id of removeProductIds) {
    if (!productsById[id]) violations.push(`unknown_remove_id:${id}`);
  }
  for (const id of scaleProductIds) {
    if (!productsById[id]) violations.push(`unknown_scale_id:${id}`);
    const p = productsById[id];
    if (p && String(p.status || "").toLowerCase() === "removed") violations.push(`invalid_scale_removed:${id}`);
  }
  for (const upd of priceUpdates) {
    if (!productsById[upd.id]) violations.push(`unknown_price_id:${upd.id}`);
    if (!Number.isFinite(Number(upd.newPrice)) || Number(upd.newPrice) <= 0) {
      violations.push(`invalid_price:${upd.id}`);
    }
  }
  if (plan && Array.isArray(plan.actions)) {
    for (const action of plan.actions) {
      const t = String(action && action.type ? action.type : "").toLowerCase();
      if (t === "delete") violations.push("delete_not_allowed");
      if (t && !ALLOWED_ACTIONS.includes(t)) violations.push(`action_not_allowed:${t}`);
    }
  }
  return { filtered, violations };
}

function validatePlan(plan, productsById, storeConfig, systemState) {
  if (!plan || typeof plan !== "object") {
    return { ok: false, reason: "plan_missing_or_invalid", safePlan: null, violations: ["plan_missing_or_invalid"] };
  }
  if (systemState && systemState.circuitBreaker && systemState.circuitBreaker.tripped) {
    return { ok: false, reason: "system_in_error_state", safePlan: null, violations: ["system_in_error_state"] };
  }
  const filteredResult = filterUnsafeActions(plan, productsById);
  const violations = [...filteredResult.violations];
  const safePlan = filteredResult.filtered;
  const allIds = new Set();
  for (const id of safePlan.removeProductIds || []) {
    if (allIds.has(`remove:${id}`)) violations.push(`duplicate_remove:${id}`);
    allIds.add(`remove:${id}`);
  }
  for (const id of safePlan.scaleProductIds || []) {
    if (allIds.has(`scale:${id}`)) violations.push(`duplicate_scale:${id}`);
    allIds.add(`scale:${id}`);
  }
  for (const p of safePlan.priceUpdates || []) {
    if (allIds.has(`price:${p.id}`)) violations.push(`duplicate_price:${p.id}`);
    allIds.add(`price:${p.id}`);
  }
  if ((safePlan.removeProductIds || []).length > MAX_DEACTIVATE_ACTIONS_PER_CYCLE) {
    violations.push("deactivate_limit_exceeded");
  }
  if ((safePlan.scaleProductIds || []).length > MAX_SCALE_ACTIONS_PER_CYCLE) {
    violations.push("scale_limit_exceeded");
  }
  if ((safePlan.priceUpdates || []).length > MAX_PRICE_ACTIONS_PER_CYCLE) {
    violations.push("price_limit_exceeded");
  }
  const total = (safePlan.removeProductIds || []).length + (safePlan.scaleProductIds || []).length + (safePlan.priceUpdates || []).length;
  if (total > MAX_ACTIONS_PER_CYCLE) {
    violations.push("max_actions_exceeded");
  }
  if (violations.length) {
    return { ok: false, reason: "plan_validation_failed", safePlan: null, violations };
  }
  return { ok: true, reason: "ok", safePlan, violations: [] };
}

function pickDeterministicDeactivateCandidates(products, count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n <= 0) return [];
  const pool = [...(products || [])]
    .filter((p) => p && p.id && String(p.status || "").toLowerCase() !== "removed" && String(p.status || "").toLowerCase() !== "inactive")
    .sort((a, b) => {
      const scoreA = Number(a.score) || 0;
      const scoreB = Number(b.score) || 0;
      if (scoreA !== scoreB) return scoreA - scoreB;
      return String(a.id).localeCompare(String(b.id));
    });
  return pool.slice(0, n).map((p) => String(p.id));
}

function buildTargetStatePlan(products, storeConfig) {
  const activeCount = countShopfrontCatalogProducts(products);
  const inactiveCount = (products || []).filter((p) => String(p.status || "").toLowerCase() === "inactive").length;
  const configuredTarget = Number(storeConfig && storeConfig.maxCatalogProducts) || DEFAULT_TARGET_ACTIVE_PRODUCTS;
  const targetActive = Math.max(1, configuredTarget);
  const targetMaxInactive = DEFAULT_TARGET_MAX_INACTIVE;
  const needCreate = Math.max(0, targetActive - activeCount);
  const needDeactivate = Math.max(0, activeCount - targetActive);
  const deactivateBudget = Math.max(0, targetMaxInactive - inactiveCount);
  const deactivateCount = Math.min(needDeactivate, deactivateBudget, MAX_DEACTIVATE_ACTIONS_PER_CYCLE);
  return {
    targetActive,
    targetMaxInactive,
    activeCount,
    inactiveCount,
    plan: {
      addProducts: needCreate,
      removeProductIds: pickDeterministicDeactivateCandidates(products, deactivateCount),
    },
  };
}

function buildExecutionQueueFromPlan(plan) {
  const queue = [];
  const removeIds = deterministicUniqueSortedIds(plan && plan.removeProductIds);
  const scaleIds = deterministicUniqueSortedIds(plan && plan.scaleProductIds);
  const priceUpdates = deterministicPriceAdjustments(plan && (plan.priceUpdates || plan.priceAdjustments));
  for (const id of removeIds) queue.push({ type: "deactivate", priority: 1, id });
  for (const id of scaleIds) queue.push({ type: "update", operation: "scale", priority: 2, id });
  for (const update of priceUpdates) {
    queue.push({ type: "update", operation: "price", priority: 3, id: update.id, newPrice: update.newPrice });
  }
  return queue.sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id));
}

function validateExecutionQueue(queue, productsById, systemState) {
  const violations = [];
  const accepted = [];
  if (systemState && systemState.circuitBreaker && systemState.circuitBreaker.tripped) {
    return { accepted: [], violations: ["system_in_error_state"], counts: { total: 0, deactivate: 0, scale: 0, price: 0 } };
  }
  const seen = new Set();
  let deactivates = 0, scales = 0, prices = 0;
  for (const action of queue || []) {
    if (!action || !action.type) {
      violations.push("invalid_action_shape");
      continue;
    }
    if (String(action.type).toLowerCase() === "delete") {
      violations.push("delete_not_allowed");
      continue;
    }
    if (!ALLOWED_ACTIONS.includes(action.type)) {
      violations.push(`action_not_allowed:${String(action.type)}`);
      continue;
    }
    if (!action.id || !productsById[action.id]) {
      violations.push(`unknown_id:${String(action.id || "")}`);
      continue;
    }
    const dupKey = `${action.type}:${action.operation || ""}:${action.id}`;
    if (seen.has(dupKey)) {
      violations.push(`duplicate_action:${dupKey}`);
      continue;
    }
    seen.add(dupKey);
    if (action.type === "deactivate") deactivates += 1;
    if (action.type === "update" && action.operation === "scale") scales += 1;
    if (action.type === "update" && action.operation === "price") prices += 1;
    accepted.push(action);
  }
  if (accepted.length > MAX_ACTIONS_PER_CYCLE) violations.push("max_actions_exceeded");
  if (deactivates > MAX_DEACTIVATE_ACTIONS_PER_CYCLE) violations.push("deactivate_limit_exceeded");
  if (scales > MAX_SCALE_ACTIONS_PER_CYCLE) violations.push("scale_limit_exceeded");
  if (prices > MAX_PRICE_ACTIONS_PER_CYCLE) violations.push("price_limit_exceeded");
  for (const action of accepted) {
    if (action.type === "deactivate") {
      const p = productsById[action.id];
      if (!p || String(p.status || "").toLowerCase() === "removed") violations.push(`invalid_deactivate:${action.id}`);
    }
    if (action.type === "update" && action.operation === "price") {
      const np = Number(action.newPrice);
      if (!Number.isFinite(np) || np <= 0) violations.push(`invalid_price:${action.id}`);
    }
    if (action.type === "update" && !["scale", "price"].includes(String(action.operation || "").toLowerCase())) {
      violations.push(`invalid_update_operation:${action.id}`);
    }
  }
  if (violations.length) {
    return {
      accepted: [],
      violations,
      counts: { total: 0, deactivate: 0, scale: 0, price: 0 },
    };
  }
  return {
    accepted,
    violations,
    counts: { total: accepted.length, deactivate: deactivates, scale: scales, price: prices },
  };
}

function fallbackCandidateSignals(raw, evalResult, rank, storeConfig) {
  const cost = Number(raw?.price) || Number(evalResult?.price) || 0;
  const ai = Number(evalResult?.aiScore) || 0;
  const pop = Number(evalResult?.marketplace?.popularity_score) || 0;
  const demand = Math.max(0, Math.min(100, pop * 0.7 + ai * 0.3));
  const provisionalPrice =
    Number(raw?._provisionalPrice) ||
    Number(evalResult?._provisionalPrice) ||
    priceFromCostDeterministic(cost, String(evalResult?.sourceProductId || raw?.externalId || raw?.title || "fallback"), null, storeConfig);
  const shipping = estimateShippingCost(
    { cost, category: evalResult?.category || raw?.category || "other" },
    storeConfig
  );
  const unitProfit = Number((provisionalPrice - cost - shipping).toFixed(2));
  const marginPct = provisionalPrice > 0 ? Number((((provisionalPrice - cost) / provisionalPrice) * 100).toFixed(2)) : 0;
  const fallbackScore = Number((unitProfit * 0.45 + demand * 0.25 + ai * 0.2 + Number(rank || 0) * 0.1).toFixed(2));
  return { unitProfit, marginPct, demand, ai, fallbackScore, provisionalPrice };
}

async function snapshotFallbackPerformance(supabase, cycleId) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("products")
      .select("id, created_at, views, clicks, orders_count, price, cost, estimated_shipping_cost, import_method")
      .ilike("import_method", "%fallback_low_confidence%");
    if (error) return null;
    const rows = data || [];
    if (!rows.length) return { count: 0, time_to_first_sale_hours: null, conversion_rate: 0, profit_contribution: 0 };
    let sold = 0;
    let totalHoursToSale = 0;
    let clicks = 0;
    let orders = 0;
    let profit = 0;
    for (const r of rows) {
      const o = Number(r.orders_count) || 0;
      const c = Number(r.clicks) || 0;
      const p = Number(r.price) || 0;
      const k = Number(r.cost) || 0;
      const s = Number(r.estimated_shipping_cost) || 0;
      orders += o;
      clicks += c;
      profit += o * Math.max(0, p - k - s);
      if (o > 0) {
        sold += 1;
        const ageHours = Math.max(0, (Date.now() - Date.parse(r.created_at || 0)) / 3600000);
        totalHoursToSale += ageHours;
      }
    }
    const snap = {
      count: rows.length,
      time_to_first_sale_hours: sold > 0 ? Number((totalHoursToSale / sold).toFixed(2)) : null,
      conversion_rate: Number((orders / Math.max(clicks, 1)).toFixed(4)),
      profit_contribution: Number(profit.toFixed(2)),
    };
    await logAi(supabase, "fallback_performance_snapshot", { cycleId, ...snap });
    return snap;
  } catch {
    return null;
  }
}

function adjustFallbackPolicyFromPerformance(perf) {
  if (!perf) return;
  const next = { ...(state.fallbackPolicy || { minMarginPct: 10, minScore: 40 }) };
  if (Number(perf.conversion_rate) >= 0.03 && Number(perf.profit_contribution) > 0) {
    next.minScore = Math.max(30, next.minScore - 2);
    next.minMarginPct = Math.max(8, next.minMarginPct - 1);
  } else if (Number(perf.conversion_rate) < 0.01 || Number(perf.profit_contribution) <= 0) {
    next.minScore = Math.min(65, next.minScore + 3);
    next.minMarginPct = Math.min(20, next.minMarginPct + 1);
  }
  state.fallbackPolicy = next;
}

/** Observability: discovery kalder denne via options (undgår circular import). */
function makeDiscoveryLogger(supabase, cycleId) {
  if (!supabase) return null;
  return async (action, payload) => {
    await logAi(supabase, action, { ...(payload || {}), cycleId: cycleId != null ? cycleId : payload?.cycleId });
  };
}

/** Observability: knyt ai_log til ét sourcing-run via meta.runId (optional). */
function withRunMeta(details, runId) {
  if (!runId) return { ...(details || {}) };
  const d = { ...(details || {}) };
  const prevMeta =
    d.meta && typeof d.meta === "object" && !Array.isArray(d.meta) ? d.meta : {};
  return { ...d, runId, meta: { ...prevMeta, runId } };
}

async function logAi(supabase, action, details) {
  if (!supabase) return;
  const payload = details || {};
  const row = {
    action,
    product_id: payload.product_id || payload.id || null,
    cycle_id: payload.cycleId || null,
    metadata: payload,
    reason: payload.reason || null,
    ai_confidence: payload.ai_confidence != null ? payload.ai_confidence : null,
    before: payload.before || null,
    after: payload.after || null,
    details: payload,
    created_at: new Date().toISOString(),
  };
  try {
    const { error } = await supabase.from("ai_log").insert(row);
    if (error) {
      logger.warn("automation.ai_log.insert_fallback", { action, error: error.message || String(error) });
      await supabase.from("ai_log").insert({ action, details: payload });
    }
  } catch (e) {
    logger.error("automation.ai_log.insert_failed", {
      action,
      cycleId: payload.cycleId || null,
      productId: payload.product_id || payload.id || null,
      error: e && e.message ? e.message : String(e),
    });
  }
}

async function saveMemories(supabase, insights) {
  if (!supabase || !insights?.length) return;
  const rows = insights
    .filter(Boolean)
    .slice(0, 8)
    .map((insight) => ({ insight: String(insight).slice(0, 2000) }));
  if (rows.length) await supabase.from("ai_memory").insert(rows);
}

async function loadMemories(supabase, limit = 12) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("ai_memory")
    .select("id, insight, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return data || [];
}

async function loadProducts(supabase) {
  if (!supabase) return [];
  const { data, error } = await supabase.from("products").select("*");
  if (error) throw error;
  return data || [];
}

async function syncScores(supabase, products) {
  if (!supabase) return;
  const nowIso = new Date().toISOString();
  const rows = (products || []).map((p) => ({
    id: p.id,
    score: performanceScore(p),
    performance_score: performanceScore(p),
    confidence_score:
      Math.round(
        ((Number(p.ai_fit_score) || 0) * 0.5 + performanceScore(p) * 0.5) * 100
      ) / 100,
    updated_at: nowIso,
  })).filter((row) => row.id);
  const chunkSize = 75;
  for (let i = 0; i < rows.length; i += chunkSize) {
    await supabase.from("products").upsert(rows.slice(i, i + chunkSize), { onConflict: "id" });
  }
}

async function applyPlan(supabase, plan, productsById, cycleId) {
  const decisions = [];
  const nowIso = new Date().toISOString();
  const cooldownDays = Math.max(1, Number(process.env.REMOVE_COOLDOWN_DAYS) || 14);
  const cooldownUntil = new Date(Date.now() + cooldownDays * 24 * 60 * 60 * 1000).toISOString();
  const dryRun = Boolean(plan && plan.__dryRun);
  const queue = buildExecutionQueueFromPlan(plan);
  const validated = validateExecutionQueue(queue, productsById, state);
  if (validated.violations.length) {
    await logAi(supabase, "plan_validated_with_limits", {
      cycleId,
      violations: validated.violations,
      queueRequested: queue.length,
      queueAccepted: validated.accepted.length,
      hardLimits: getAutomationState().hardLimits,
    });
    return [];
  }
  for (const action of validated.accepted) {
    if (action.type === "delete") {
      throw new Error("DELETE NOT ALLOWED");
    }
    if (action.type === "deactivate") {
      const prev = productsById[action.id];
      if (!prev || prev.status === "inactive" || prev.status === "removed") continue;
      if (dryRun) {
        decisions.push({ type: "deactivate", id: prev.id, name: prev.name, dryRun: true });
        continue;
      }
      const { data: row } = await supabase
        .from("products")
        .update({ status: "inactive", cooldown_until: cooldownUntil, updated_at: nowIso })
        .eq("id", action.id)
        .select("id, name")
        .maybeSingle();
      if (!row) continue;
      const profitImpact = Number(
        (
          -Math.max(
            0,
            ((Number(prev.price) || 0) - (Number(prev.cost) || 0) - (Number(prev.estimated_shipping_cost) || 0)) *
              (Number(prev.orders_count) || 0)
          )
        ).toFixed(2)
      );
      decisions.push({ type: "deactivate", id: row.id, name: row.name });
      await logProductTransition(supabase, {
        product_id: row.id,
        from_status: prev.status || null,
        to_status: "inactive",
        from_sourcing: prev.sourcing_status || null,
        to_sourcing: prev.sourcing_status || null,
        reason: "automation_plan_deactivate",
        actor_type: "automation_worker",
        cycle_id: cycleId,
      });
      await logAi(supabase, "product_deactivated", {
        id: row.id,
        name: row.name,
        product_id: row.id,
        cycleId,
        reason: "low conversion + low margin",
        profit_impact: profitImpact,
        cooldown_until: cooldownUntil,
      });
      await recordDecision(supabase, {
        cycle_id: cycleId,
        decision_type: "deactivate",
        product_id: row.id,
        category: prev.category || null,
        source_name: prev.source_name || prev.source_platform || null,
        hypothesis: "Deactivating low-performance SKU should lift portfolio profitability safely.",
        expected_effect: "higher margin quality",
        confidence: 0.7,
        before_state: { status: prev.status, sourcing_status: prev.sourcing_status, score: prev.score, price: prev.price },
        after_state: { status: "inactive", cooldown_until: cooldownUntil, profit_impact: profitImpact },
      });
      continue;
    }
    if (action.type === "update" && action.operation === "scale") {
      const prev = productsById[action.id];
      if (!prev || prev.status === "removed") continue;
      if (dryRun) {
        decisions.push({ type: "scale", id: prev.id, name: prev.name, dryRun: true });
        continue;
      }
      const { data: row } = await supabase
        .from("products")
        .update({ status: "scaling", updated_at: nowIso })
        .eq("id", action.id)
        .select("id, name")
        .maybeSingle();
      if (!row) continue;
      const profitImpact = Number(
        (
          Math.max(
            0,
            ((Number(prev.price) || 0) - (Number(prev.cost) || 0) - (Number(prev.estimated_shipping_cost) || 0)) *
              Math.max(1, Number(prev.orders_count) || 0) *
              0.15
          )
        ).toFixed(2)
      );
      decisions.push({ type: "scale", id: row.id, name: row.name });
      await logProductTransition(supabase, {
        product_id: row.id,
        from_status: prev.status || null,
        to_status: "scaling",
        from_sourcing: prev.sourcing_status || null,
        to_sourcing: prev.sourcing_status || null,
        reason: "automation_plan_scale",
        actor_type: "automation_worker",
        cycle_id: cycleId,
      });
      await logAi(supabase, "product_scaled", {
        id: row.id,
        name: row.name,
        product_id: row.id,
        cycleId,
        reason: "high demand + strong unit profit",
        profit_impact: profitImpact,
      });
      await recordDecision(supabase, {
        cycle_id: cycleId,
        decision_type: "scale",
        product_id: row.id,
        category: prev.category || null,
        source_name: prev.source_name || prev.source_platform || null,
        hypothesis: "Scaling high confidence SKU should increase conversion and profit.",
        expected_effect: "higher volume",
        confidence: 0.68,
        before_state: { status: prev.status, score: prev.score, confidence: prev.confidence_score },
        after_state: { status: "scaling", profit_impact: profitImpact },
      });
      continue;
    }
    if (action.type === "update" && action.operation === "price") {
      const p = productsById[action.id];
      if (!p) continue;
      const oldPrice = Number(p.price);
      const parsedPrice = Number(action.newPrice);
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) continue;
      const np = Math.max(29, parsedPrice);
      if (dryRun) {
        decisions.push({ type: "price", id: action.id, name: p.name, oldPrice, newPrice: np, dryRun: true });
        continue;
      }
      await supabase.from("products").upsert([{ id: action.id, price: np, updated_at: nowIso }], { onConflict: "id" });
      decisions.push({ type: "price", id: action.id, name: p.name, oldPrice, newPrice: np });
      await recordPriceElasticityChange(supabase, p, oldPrice, np, cycleId);
      const oldUnitProfit = Number(
        (oldPrice - (Number(p.cost) || 0) - (Number(p.estimated_shipping_cost) || 0) - (Number(p.return_risk_proxy) || 0)).toFixed(2)
      );
      const newUnitProfit = Number(
        (np - (Number(p.cost) || 0) - (Number(p.estimated_shipping_cost) || 0) - (Number(p.return_risk_proxy) || 0)).toFixed(2)
      );
      const profitImpact = Number((newUnitProfit - oldUnitProfit).toFixed(2));
      await logAi(supabase, "price_updated", {
        id: action.id,
        name: p.name,
        product_id: action.id,
        oldPrice,
        newPrice: np,
        cycleId,
        reason: "price optimization with margin floor",
        profit_impact: profitImpact,
      });
      await recordDecision(supabase, {
        cycle_id: cycleId,
        decision_type: "price",
        product_id: action.id,
        category: p.category || null,
        source_name: p.source_name || p.source_platform || null,
        hypothesis: "Price update should improve profit per view without harming conversion.",
        expected_effect: "profit uplift",
        confidence: 0.62,
        before_state: { price: oldPrice, conversion: (Number(p.orders_count) || 0) / Math.max(Number(p.views) || 0, 1) },
        after_state: { price: np, unit_profit: newUnitProfit, profit_impact: profitImpact },
      });
    }
  }

  return decisions;
}

function computeCandidateRank(evalResult, raw, sourceMetricsMap, products, categoryLearningMap, storeConfig) {
  const ai = Number(evalResult.aiScore) || 0;
  const cost = Number(raw.price) || Number(evalResult.price) || 0;
  const provisionalPrice = priceFromCostDeterministic(cost, String(evalResult.sourceProductId || raw.externalId || evalResult.title || raw.title || "velden"));
  const margin = Math.max(0, provisionalPrice - cost);
  const priceQuality = cost > 0 ? Math.min(100, (margin / cost) * 100) : 0;
  const srcKey = String(evalResult.sourceName || evalResult.sourcePlatform || "").toLowerCase();
  const src = sourceMetricsMap && sourceMetricsMap.get(srcKey);
  const srcWeight = sourceDiscoveryWeight(src);
  const srcBoost = src ? ((Number(src.success_rate) || 0) * 12 + (Number(src.avg_profit) > 0 ? 4 : -4)) * srcWeight : 0;
  const catPenalty = categoryRankPenalty(evalResult.category || raw.category || "other", products);
  const catLearning = categoryLearningMap && categoryLearningMap.get(String(evalResult.category || raw.category || "other"));
  const catBoost = catLearning
    ? (Number(catLearning.avg_profit) > 0 ? 5 : -3) + (Number(catLearning.avg_conversion) || 0) * 60
    : 0;
  const goalRaw =
    (storeConfig && (storeConfig.goal || (storeConfig.strategy && storeConfig.strategy.goal))) || "profit";
  const goal = String(goalRaw).includes("growth")
    ? "growth"
    : String(goalRaw).includes("balance")
      ? "balanced"
      : "profit";
  const riskLevel =
    (storeConfig && (storeConfig.risk_level || (storeConfig.strategy && storeConfig.strategy.risk))) || "balanced";
  const merchScore = computeMerchScore({
    goal,
    riskLevel,
    marginPct: cost > 0 ? margin / cost : 0,
    ctr: 0,
    trendScore: Math.max(0, Math.min(100, ai + srcBoost)),
    aiFit: ai,
    supplierName: evalResult.supplierName || raw.supplierName || "",
  });
  return merchScore * 0.7 + priceQuality * 0.2 + srcBoost + catBoost - catPenalty;
}

function rawCandidateAllowedByEnabledSources(raw, storeConfig) {
  if (!storeConfig || !Array.isArray(storeConfig.enabledSources) || !storeConfig.enabledSources.length) {
    return true;
  }
  const tokens = storeConfig.enabledSources.map((s) => String(s || "").toLowerCase()).filter(Boolean);
  const srcName = String(raw.sourceName || "").toLowerCase();
  const srcPlat = String(raw.sourcePlatform || "").toLowerCase();
  const im = String(raw.importMethod || "").toLowerCase();
  if (tokens.some((t) => srcName.includes(t) || srcPlat.includes(t))) return true;
  /** HTTP discovery rækker har typisk importMethod scrape — matcher eksplicit «web» el.l. i dashboard. */
  if (im === "scrape" && tokens.some((t) => ["web", "http", "https", "discovery", "scrape"].includes(t)))
    return true;
  if (
    (im === "shopify_api" || im === "shopify_storefront_json" || im === "shopify_products_json") &&
    tokens.some((t) => t.includes("shopify"))
  )
    return true;
  if (im === "ebay_browse_api" && tokens.some((t) => t.includes("ebay"))) return true;
  return false;
}

async function insertEnrichedProducts(supabase, rawList, count, cycleId, strategyState, storeConfig, runId, opts = {}) {
  const dryRun = Boolean(opts && opts.dryRun);
  console.log("STEP:", "insert.pipeline.start", {
    count: Array.isArray(rawList) ? rawList.length : 0,
    status: "running",
    reason: null,
  });
  const trendPack = generateCategoryQueryPack({ storeConfig, categoryIntent: null, chatSearchHint: "" });
  const trends = (trendPack && trendPack.debug && trendPack.debug.trends) || [];
  const learningMemory = getLearningMemory(storeConfig);
  const boostedProducts = [];
  const externalIds = await loadExternalIdSet(supabase);
  const userMemory = await loadSourcingUserRejects(supabase);
  const productsNow = await loadProducts(supabase);
  const categoryAvgPrice = categoryAveragePriceMap(productsNow);
  const sourceMetricsMap = await loadSourceMetricsMap(supabase);
  const categoryLearningMap = await loadCategoryLearningMap(supabase);
  const evaluated = [];
  let skippedBySourcePolicy = 0;
  const skippedBySourceSamples = [];
  let rejectedCount = 0;
  let skippedByCategoryCount = 0;
  const rejected = [];
  const reasonsBreakdown = {};
  const fallbackPool = [];
  const lowConfidenceFallbackPool = [];
  const minCandidateGuarantee = Math.max(3, Math.min(5, Number(process.env.SOURCING_MIN_CANDIDATE_GUARANTEE) || 3));
  const markRejected = (raw, reason) => {
    rejectedCount += 1;
    const r = String(reason || "unknown");
    reasonsBreakdown[r] = (reasonsBreakdown[r] || 0) + 1;
    if (rejected.length < 120) {
      rejected.push({ product: String((raw && raw.title) || "").slice(0, 180), reason: r });
    }
  };

  for (const raw of rawList || []) {
    raw._trace = {
      source: String(raw.importMethod || raw.sourcePlatform || ""),
      passedSourceFilter: true,
      passedCategory: true,
      rejectedReason: null,
    };

    if (!rawCandidateAllowedByEnabledSources(raw, storeConfig)) {
      raw._trace.passedSourceFilter = false;
      raw._trace.rejectedReason = "source_policy";
      skippedBySourcePolicy += 1;
      if (skippedBySourceSamples.length < 10) {
        skippedBySourceSamples.push({
          title: String(raw.title || "").slice(0, 120),
          importMethod: raw.importMethod || "",
          sourcePlatform: raw.sourcePlatform || "",
          sourceName: raw.sourceName || "",
        });
      }
      markRejected(raw, "source_policy");
      continue;
    }
    const mem = candidateBlockedByUserMemory(raw, userMemory);
    if (mem.blocked) {
      raw._trace.rejectedReason = mem.reason || "user_memory";
      markRejected(raw, raw._trace.rejectedReason);
      if (!dryRun) {
        await logAi(
        supabase,
        "sourcing_skipped_user_memory",
        withRunMeta(
          {
            title: raw.title,
            reason: mem.reason,
            similarity: mem.similarity,
            cooldown_until: mem.cooldown_until || null,
            cycleId,
          },
          runId
        )
        );
      }
      continue;
    }
    const sourceMeta = {
      sourcePlatform: raw.sourcePlatform || "",
      sourceName: raw.sourceName || "",
      sourceUrl: raw.sourceUrl || "",
      sourceProductId: raw.sourceProductId || raw.externalId || "",
      supplierName: raw.supplierName || "",
      supplierCountry: raw.supplierCountry || "",
      importMethod: raw.importMethod || "",
    };
    const evalResult = await evaluateVeldenSourcing(raw, sourceMeta, { storeConfig });
    const pop = computePopularityScore({
      sold_count: raw.sold_count,
      review_count: raw.review_count,
      rating: raw.rating,
      listing_date: raw.listing_date,
    });
    const baseAi = Number(evalResult.aiScore) || 0;
    const popCombinedAi = combineAiWithPopularity(baseAi, pop.score);
    const cat = normalizeCategoryId(evalResult.category || raw.category || "other");
    const priceSanity = evaluatePriceSanity({
      price: Number(raw.price) || Number(evalResult.price) || 0,
      categoryAvgPrice: categoryAvgPrice.get(cat),
    });
    const recencyScore =
      pop.recency_level === "new" ? 90 : pop.recency_level === "mid" ? 65 : pop.recency_level === "old" ? 35 : 50;
    const popularityForFinal = Number.isFinite(Number(pop.score)) ? Number(pop.score) : popCombinedAi;
    const popularityAdjust =
      pop.level === "low" ? -20 : pop.level === "high" ? 8 : pop.level === "unknown" ? -4 : 0;
    let finalAi =
      0.5 * popCombinedAi + 0.3 * popularityForFinal + 0.2 * recencyScore - Number(priceSanity.penalty || 0) + popularityAdjust;
    const conf = computeConfidenceScore({
      sold_count: raw.sold_count,
      review_count: raw.review_count,
      rating: raw.rating,
      ai_score: finalAi,
      popularity_score: pop.score,
    });
    if (conf.confidence === "low") finalAi -= 10;
    const trendMatch = matchesTrendText(
      `${evalResult.title || raw.title || ""} ${evalResult.category || raw.category || ""}`,
      trends
    );
    if (trendMatch) {
      finalAi += Math.min(10, Math.max(3, Number(trendMatch.trend_score || 0) * 0.08));
      boostedProducts.push({
        title: String(evalResult.title || raw.title || "").slice(0, 180),
        keyword: trendMatch.keyword,
        trend_score: Number(trendMatch.trend_score || 0),
      });
    }
    const titleLc = String(evalResult.title || raw.title || "").toLowerCase();
    const catLc = normalizeCategoryId(evalResult.category || raw.category || "other");
    const winK = (learningMemory && learningMemory.winning_keywords) || [];
    const loseK = (learningMemory && learningMemory.losing_keywords) || [];
    const winC = new Set((learningMemory && learningMemory.winning_categories) || []);
    const loseC = new Set((learningMemory && learningMemory.losing_categories) || []);
    if (winK.some((k) => k && titleLc.includes(String(k).toLowerCase())) || winC.has(catLc)) {
      finalAi += 10;
    }
    if (loseK.some((k) => k && titleLc.includes(String(k).toLowerCase())) || loseC.has(catLc)) {
      finalAi -= 15;
    }
    finalAi = Math.max(0, Math.min(100, Number(finalAi.toFixed(2))));
    evalResult.aiScore = finalAi;
    evalResult.marketplace = {
      popularity_score: pop.score,
      popularity_level: pop.level,
      recency_level: pop.recency_level || "unknown",
      age_days: pop.age_days != null ? Number(pop.age_days) : null,
      sold_count: raw.sold_count ?? null,
      review_count: raw.review_count ?? null,
      rating: raw.rating ?? null,
      price_flag: priceSanity.price_flag,
      confidence: conf.confidence,
      confidence_score: conf.confidence_score,
    };
    if (evalResult.status === "rejected") {
      raw._trace.rejectedReason = evalResult.brandFitReason || "rejected";
      markRejected(raw, raw._trace.rejectedReason);
      lowConfidenceFallbackPool.push({
        raw,
        evalResult: { ...evalResult, status: "approved", brandFitReason: "low_confidence_fallback" },
        rank: computeCandidateRank(evalResult, raw, sourceMetricsMap, productsNow, categoryLearningMap, storeConfig),
        rankPenalty: 15,
      });
      if (!dryRun) {
        await logAi(
        supabase,
        "product_sourcing_rejected",
        withRunMeta(
          {
            title: evalResult.title,
            reason: evalResult.brandFitReason,
            aiScore: evalResult.aiScore,
            category: evalResult.category || raw.category || null,
            importMethod: evalResult.importMethod || raw.importMethod || "",
            sourcePlatform: evalResult.sourcePlatform || raw.sourcePlatform || "",
            cycleId,
            meta: { title: evalResult.title || raw.title, trace: { ...raw._trace } },
          },
          runId
        )
        );
      }
      continue;
    }
    if (pop.level === "medium" && finalAi < (conf.confidence === "low" ? 86 : 78)) {
      raw._trace.rejectedReason = "popularity_medium_ai_low";
      markRejected(raw, raw._trace.rejectedReason);
      fallbackPool.push({
        raw,
        evalResult,
        rank: computeCandidateRank(evalResult, raw, sourceMetricsMap, productsNow, categoryLearningMap, storeConfig),
        rankPenalty: 0,
      });
      continue;
    }
    const dedupeKey = String(evalResult.sourceProductId || raw.externalId || "").trim();
    if (!dedupeKey || externalIds.has(dedupeKey)) {
      raw._trace.rejectedReason = "duplicate_external_id";
      markRejected(raw, raw._trace.rejectedReason);
      continue;
    }
    if (!canInsertCategory(evalResult.category || raw.category || "other", productsNow)) {
      skippedByCategoryCount += 1;
      raw._trace.passedCategory = false;
      raw._trace.rejectedReason = "category_cap";
      markRejected(raw, raw._trace.rejectedReason);
      fallbackPool.push({
        raw,
        evalResult,
        rank: computeCandidateRank(evalResult, raw, sourceMetricsMap, productsNow, categoryLearningMap, storeConfig),
        rankPenalty: 0,
      });
      if (!dryRun) {
        await logAi(
        supabase,
        "sourcing_skipped_category_cap",
        withRunMeta(
          {
            cycleId,
            category: evalResult.category || raw.category || "other",
            title: evalResult.title || raw.title,
          },
          runId
        )
        );
      }
      continue;
    }
    evaluated.push({
      raw,
      evalResult,
      rank: computeCandidateRank(evalResult, raw, sourceMetricsMap, productsNow, categoryLearningMap, storeConfig),
      rankPenalty:
        evalResult.marketplace && evalResult.marketplace.price_flag && evalResult.marketplace.price_flag !== "ok"
          ? 12
          : 0,
    });
  }
  if (evaluated.length === 0 && fallbackPool.length) {
    const relaxed = fallbackPool
      .sort((a, b) => Number(b.rank || 0) - Number(a.rank || 0))
      .slice(0, minCandidateGuarantee);
    for (const x of relaxed) evaluated.push(x);
  }
  if (evaluated.length === 0 && lowConfidenceFallbackPool.length) {
    const policy = state.fallbackPolicy || { minMarginPct: 10, minScore: 40 };
    const ranked = lowConfidenceFallbackPool
      .map((item) => ({ ...item, signals: fallbackCandidateSignals(item.raw, item.evalResult, item.rank, storeConfig) }))
      .filter((x) => x.signals.unitProfit > 0 && x.signals.marginPct >= policy.minMarginPct && x.signals.fallbackScore >= policy.minScore)
      .sort((a, b) => Number(b.signals.fallbackScore || 0) - Number(a.signals.fallbackScore || 0));
    const forced = ranked.slice(0, Math.max(1, Math.min(3, Number(count) || 3)));
    for (const x of forced) evaluated.push(x);
    console.log("STEP:", "insert.low_confidence_fallback", {
      count: forced.length,
      status: forced.length > 0 ? "ok" : "no_results",
      reason: forced.length > 0 ? "all_rejected_relaxed_ranked" : "fallback_quality_floor",
    });
    if (!dryRun) {
      await logAi(
        supabase,
        "sourcing_low_confidence_fallback",
        withRunMeta(
          {
            cycleId,
            forcedCount: forced.length,
            reason: forced.length > 0 ? "all_candidates_rejected_ranked" : "all_candidates_rejected_quality_floor",
            policy,
          },
          runId
        )
      );
    }
  }

  if (!dryRun && skippedBySourcePolicy > 0) {
    await logAi(
      supabase,
      "sourcing_skipped_source_policy",
      withRunMeta(
        {
          cycleId,
          count: skippedBySourcePolicy,
          enabledSources:
            storeConfig && Array.isArray(storeConfig.enabledSources) ? storeConfig.enabledSources : [],
          samples: skippedBySourceSamples,
        },
        runId
      )
    );
  }

  evaluated.sort((a, b) => (b.rank - (b.rankPenalty || 0)) - (a.rank - (a.rankPenalty || 0)));
  const exploitCount = Math.max(1, Math.floor(count * Number((strategyState && strategyState.exploitRatio) || 0.8)));
  const exploreCount = Math.max(0, count - exploitCount);
  const pickedRaw = [
    ...evaluated.slice(0, exploitCount),
    ...evaluated
      .slice(exploitCount)
      .sort(() => Math.random() - 0.5)
      .slice(0, exploreCount),
  ];
  const picked = balancedPickByCategory(
    pickedRaw,
    count,
    Number((storeConfig && storeConfig.maxCategoryShare) || process.env.SOURCING_MAX_CATEGORY_SHARE || 0.5)
  );
  let added = 0;
  let acceptedCount = 0;
  let queuedCount = 0;
  let insertedCount = 0;
  const processedRows = [];
  const dryRunCandidates = [];
  const goalRaw = (storeConfig && (storeConfig.goal || (storeConfig.strategy && storeConfig.strategy.goal))) || "profit";
  const goal = String(goalRaw).includes("growth") ? "growth" : String(goalRaw).includes("balance") ? "balanced" : "profit";
  const riskLevel = String(
    (storeConfig && (storeConfig.risk_level || (storeConfig.strategy && storeConfig.strategy.risk))) || "balanced"
  ).toLowerCase();
  const vibeKeywords = String(
    (storeConfig && (storeConfig.vibe_keywords || (storeConfig.sourcing && storeConfig.sourcing.merchandising && storeConfig.sourcing.merchandising.vibeKeywords))) || ""
  )
    .split(/[,;\n]/)
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  for (const item of picked) {
    if (added >= count) break;
    const raw = item.raw;
    const evalResult = item.evalResult;
    const dedupeKey = String(evalResult.sourceProductId || raw.externalId || "").trim();
    const cost = Number(raw.price) || Number(evalResult.price) || 99;
    const copy = evalResult.description
      ? {
          brand: "Velden",
          description: evalResult.description,
          selling_points: "Quiet luxury | Considered make | Tidløs herrelinje",
        }
      : await generateProductCopy(evalResult.title, cost, storeConfig);
    const pricing = computeOptimalPrice(
      {
        supplier_price: cost,
        market_price: Number(raw.price) || Number(evalResult.price) || 0,
        estimated_shipping_cost: estimateShippingCost({ cost, category: evalResult.category || raw.category || "other" }, storeConfig),
        popularity_score: evalResult.marketplace ? evalResult.marketplace.popularity_score : null,
        confidence: evalResult.marketplace ? evalResult.marketplace.confidence : "medium",
      },
      {
        goal:
          (storeConfig && (storeConfig.goal || (storeConfig.strategy && storeConfig.strategy.goal))) || "profit",
      }
    );
    const price = Number(pricing.suggested_price) || priceFromCost(cost, null, storeConfig);
    const category = evalResult.category || raw.category || inferCategory(raw.title);
    const color = raw.color || inferProductColor(evalResult.title);
    const normalizedImages = normalizeImages(raw.images || evalResult.images || [evalResult.image], evalResult.image);
    const normalizedVariants = normalizeVariants(raw.variants || evalResult.variants, {
      size: raw.sizes ? String(raw.sizes).split(",")[0] : "unknown",
      color,
      price,
      available: raw.available !== false,
    });
    const sizes = summarizeSizesFromVariants(normalizedVariants);
    const row = {
      name: evalResult.title.slice(0, 200),
      cost,
      price,
      score: 0,
      status: "active",
      sourcing_status: evalResult.status,
      brand: copy.brand,
      description: copy.description,
      selling_points: copy.selling_points,
      image_url: normalizedImages[0] || evalResult.image,
      image_urls: normalizedImages,
      external_id: dedupeKey,
      category,
      color: inferPrimaryColorFromVariants(normalizedVariants, color),
      sizes,
      supplier_variants: normalizedVariants,
      available: hasAvailableVariant(normalizedVariants),
      availability_reason: hasAvailableVariant(normalizedVariants) ? "" : "supplier_out_of_stock",
      supplier_last_checked_at: new Date().toISOString(),
      source_platform: evalResult.sourcePlatform || "",
      source_name: evalResult.sourceName || "",
      source_url: evalResult.sourceUrl || "",
      source_query: String(raw.sourceQuery || evalResult.sourceQuery || "").trim(),
      source_product_id: evalResult.sourceProductId || "",
      supplier_name: evalResult.supplierName || "",
      supplier_country: evalResult.supplierCountry || "",
      import_method: evalResult.importMethod || "",
      discovery_mode: String(raw.discovery_selection_mode || "exploit"),
      ai_fit_score: evalResult.aiScore,
      brand_fit_reason: evalResult.brandFitReason || "",
      source_quality_score: evalResult.sourceQuality ? evalResult.sourceQuality.total : null,
      popularity_level: evalResult.marketplace ? evalResult.marketplace.popularity_level : "unknown",
      recency_level: evalResult.marketplace ? evalResult.marketplace.recency_level : "unknown",
      price_flag: evalResult.marketplace ? evalResult.marketplace.price_flag : "ok",
      confidence: evalResult.marketplace ? evalResult.marketplace.confidence : "medium",
      confidence_score: evalResult.marketplace ? evalResult.marketplace.confidence_score : null,
      sold_count: evalResult.marketplace ? evalResult.marketplace.sold_count : null,
      review_count: evalResult.marketplace ? evalResult.marketplace.review_count : null,
      experiment_variant: assignVariant({ external_id: dedupeKey, name: evalResult.title }),
    };
    if (String(row.brand_fit_reason || "").includes("low_confidence_fallback")) {
      row.import_method = "fallback_low_confidence";
    }
    row.ai_fit_score = Math.max(0, Math.min(100, Math.round(Number(row.ai_fit_score) || 0)));
    processedRows.push({ row, dedupeKey });
    if (dryRun) {
      dryRunCandidates.push({
        title: row.name,
        price: row.price,
        score: Number(item.rank || 0),
        category: normalizeCategoryId(row.category || "other"),
        popularity_level: row.popularity_level,
        recency_level: row.recency_level,
        price_flag: row.price_flag,
        confidence: row.confidence,
        confidence_score: row.confidence_score,
        sold_count: row.sold_count,
        review_count: row.review_count,
        suggested_price: pricing.suggested_price,
        margin: pricing.margin,
        reason: {
          ai: Number(evalResult.aiScore) || 0,
          popularity: {
            level: row.popularity_level,
            score: Number.isFinite(Number(evalResult.marketplace && evalResult.marketplace.popularity_score))
              ? Number(evalResult.marketplace && evalResult.marketplace.popularity_score)
              : null,
          },
          recency: row.recency_level,
          price: row.price_flag,
          confidence: { level: row.confidence, score: row.confidence_score },
          pricing: {
            suggested_price: pricing.suggested_price,
            margin: pricing.margin,
            reasoning: pricing.reasoning,
          },
          summary: `${explainDryRunCandidate({ row, rank: item.rank, goal, riskLevel, vibeKeywords })} | ${popularityReason(
            row.popularity_level,
            Number(evalResult.aiScore) || 0,
            Number((evalResult.marketplace && evalResult.marketplace.popularity_score) || NaN)
          )}`,
        },
      });
      added += 1;
      acceptedCount += 1;
      continue;
    }
    const res = await persistSourcedProductRow(supabase, row, externalIds, {
      logExtra: withRunMeta({ cycleId }, runId),
      storeConfig,
      forcePublish: row.brand_fit_reason === "low_confidence_fallback",
    });
    if (!res.ok) {
      console.log("STEP:", "insert.persist.failed", {
        count: 0,
        status: "error",
        reason: res.skip ? "duplicate_or_skipped" : res.error || "insert_failed",
      });
      continue;
    }
    acceptedCount += 1;
    if (res.queued) queuedCount += 1;
    await recordDecision(supabase, {
      cycle_id: cycleId,
      decision_type: res.queued ? "source_queue" : "source_insert",
      product_id: res.productId || null,
      category: row.category,
      source_name: row.source_name || row.source_platform || null,
      hypothesis: "High-ranked sourcing candidates should improve portfolio objective.",
      expected_effect: "incremental profit",
      confidence: Math.min(1, Math.max(0.3, (Number(evalResult.aiScore) || 0) / 100)),
      before_state: { rank: item.rank },
      after_state: {
        inserted: !res.queued,
        queued: !!res.queued,
        merged: !!res.merged,
        source: row.import_method === "fallback_low_confidence" ? "fallback" : "normal",
        confidence: row.import_method === "fallback_low_confidence" ? "low" : "normal",
      },
    });
    if (!res.merged && !res.queued) added += 1;
    if (!res.merged && !res.queued) insertedCount += 1;
  }
  if (!dryRun && insertedCount === 0 && processedRows.length > 0) {
    const forceRows = processedRows.slice(0, Math.min(3, processedRows.length));
    for (const item of forceRows) {
      const res = await persistSourcedProductRow(supabase, item.row, externalIds, {
        logExtra: withRunMeta({ cycleId, reason: "force_minimum_success_path" }, runId),
        storeConfig,
        forcePublish: true,
      });
      if (!res.ok) {
        console.log("STEP:", "insert.force_persist.failed", {
          count: 0,
          status: "error",
          reason: res.skip ? "duplicate_or_skipped" : res.error || "insert_failed",
        });
      }
      if (res.ok && !res.queued && !res.merged) {
        insertedCount += 1;
        added += 1;
      }
    }
    console.log("STEP:", "insert.force_minimum_success", {
      count: insertedCount,
      status: insertedCount > 0 ? "ok" : "no_results",
      reason: insertedCount > 0 ? "low_confidence" : "filtered_out",
    });
  }
  console.log("STEP:", "insert.pipeline.complete", {
    count: insertedCount,
    status: insertedCount > 0 ? "ok" : "no_results",
    reason: insertedCount > 0 ? null : "filtered_out",
  });
  console.log("INSERTED PRODUCTS:", insertedCount);

  if (!dryRun && runId) {
    await logAi(supabase, "sourcing_run_completed", {
      runId,
      cycleId,
      meta: {
        runId,
        totalCandidates: (rawList || []).length,
        insertedCount: added,
        queuedCount,
        acceptedCount,
        rejectedCount,
        skippedBySource: skippedBySourcePolicy,
        skippedByCategory: skippedByCategoryCount,
      },
    });
    const perf = await snapshotFallbackPerformance(supabase, cycleId);
    adjustFallbackPolicyFromPerformance(perf);
  }
  if (!dryRun && rejected.length) {
    await logAi(
      supabase,
      "sourcing_filter_rejections",
      withRunMeta({ cycleId, rejected: rejected.slice(0, 50), reasonsBreakdown }, runId)
    );
  }

  return {
    inserted: added,
    approvedCount: acceptedCount,
    queuedCount,
    rejectedCount,
    skippedBySourcePolicy,
    skippedByCategoryCount,
    qualifiedCount: evaluated.length,
    afterFiltering: evaluated.length,
    rejectedCount,
    reasonsBreakdown,
    candidates: dryRunCandidates,
    wouldInsert: dryRun ? added : undefined,
    totalFound: dryRun ? evaluated.length : undefined,
    trends: dryRun ? trends : undefined,
    boostedProducts: dryRun ? boostedProducts.slice(0, 100) : undefined,
    learning: dryRun
      ? {
          topKeywords: (learningMemory && learningMemory.winning_keywords) || [],
          avoidedKeywords: (learningMemory && learningMemory.losing_keywords) || [],
          categoriesBoosted: (learningMemory && learningMemory.winning_categories) || [],
        }
      : undefined,
  };
}

/**
 * Insert new row or append colour variant when style_key matches (same cut, different colour).
 */
async function persistSourcedProductRow(supabase, row, extSet, ctx = {}) {
  const dedupeKey = String(row.external_id || "").trim();
  if (!dedupeKey || extSet.has(dedupeKey)) return { ok: false, skip: true };
  if (!String(row.image_url || "").trim()) return { ok: false, error: "missing_image" };
  if (!Array.isArray(row.supplier_variants) || row.supplier_variants.length === 0) {
    row.supplier_variants = normalizeVariants([], {
      size: "unknown",
      color: row.color || inferProductColor(row.name || ""),
      price: Number(row.price) || 0,
      available: true,
    });
  }
  if (!Array.isArray(row.image_urls) || row.image_urls.length === 0) {
    row.image_urls = normalizeImages([], row.image_url);
  }
  row.available = hasAvailableVariant(row.supplier_variants);
  row.availability_reason = row.available ? "" : "supplier_out_of_stock";
  row.supplier_last_checked_at = row.supplier_last_checked_at || new Date().toISOString();

  const category = normalizeCategoryId(row.category);
  const displayName = canonicalProductName(row.name).slice(0, 200);
  const styleKey = styleKeyFromTitle(row.name, category);

  if (styleKey && ctx.forcePublish) {
    const mergeTarget = await findStyleMergeRow(supabase, category, styleKey);
    if (mergeTarget) {
      const snap = {
        color: row.color,
        price: row.price,
        cost: row.cost,
        image_url: row.image_url || "",
        external_id: dedupeKey,
        source_url: row.source_url || "",
        source_product_id: row.source_product_id || "",
      };
      const primaryEx = String(mergeTarget.external_id || "").trim();
      const extras = parseColorVariants(mergeTarget.color_variants);
      const extSeen = new Set(
        [primaryEx, ...extras.map((e) => String(e.external_id || "").trim())].filter(Boolean)
      );
      if (extSeen.has(dedupeKey)) return { ok: false, skip: true };
      const mergedExtras = [...extras, snap];
      const { error: upErr } = await supabase
        .from("products")
        .update({
          color_variants: mergedExtras,
          name: displayName.length >= 3 ? displayName : mergeTarget.name,
          updated_at: new Date().toISOString(),
        })
        .eq("id", mergeTarget.id);
      if (upErr) return { ok: false, error: upErr.message };
      extSet.add(dedupeKey);
      await logAi(supabase, "product_variant_merged", {
        id: mergeTarget.id,
        product_id: mergeTarget.id,
        name: displayName,
        category,
        external_id: dedupeKey,
        variant_color: row.color,
        cycleId: ctx.cycleId,
        ...(ctx.logExtra || {}),
      });
      return { ok: true, merged: true, productId: mergeTarget.id };
    }
  }

  const rank = computeProductRankScore({ views: 0, clicks: 0, orders: 0 });
  const aiFit = Number(row.ai_fit_score) || 0;
  const approvalScore = Math.max(aiFit, Number(rank.score) || 0);
  const goal = String((ctx.storeConfig && ctx.storeConfig.goal) || (ctx.storeConfig && ctx.storeConfig.strategy && ctx.storeConfig.strategy.goal) || "profit").toLowerCase();
  const riskLevel = String((ctx.storeConfig && ctx.storeConfig.risk_level) || (ctx.storeConfig && ctx.storeConfig.strategy && ctx.storeConfig.strategy.risk) || "balanced").toLowerCase();
  const riskScore = estimateRiskScore({ ...row, goal, risk_level: riskLevel });
  const approval = decideAutoApproval({
    score: approvalScore,
    riskScore,
    categoryId: category,
    views: Number(row.views) || 0,
    clicks: Number(row.clicks) || 0,
    orders: Number(row.orders_count) || 0,
    threshold:
      Math.max(
        60,
        (Number(process.env.AUTO_APPROVAL_SCORE_THRESHOLD) || 80) +
          (goal === "growth" ? -6 : goal === "balanced" ? -2 : 4) +
          (riskLevel === "high" ? -5 : riskLevel === "low" ? 5 : 0)
      ),
    riskMax: Number(process.env.AUTO_APPROVAL_RISK_MAX) || 20,
    minConfidence: Number(process.env.AUTO_APPROVAL_MIN_CONFIDENCE) || 0.35,
  });
  let enriched = {
    ...row,
    name: displayName.length >= 3 ? displayName : row.name,
    description: row.description || "",
    selling_points: row.selling_points || "",
    seo_meta_title: row.seo_meta_title || "",
    seo_meta_description: row.seo_meta_description || "",
  };
  try {
    enriched = await enrichSeoForSourcing({
      ...row,
      name: displayName.length >= 3 ? displayName : row.name,
    });
  } catch (e) {
    logger.warn("automation.seo_enrich_failed_fallback", {
      error: e && e.message ? e.message : String(e),
      name: displayName,
      category,
    });
  }
  if (!approval.publish && !ctx.forcePublish) {
    const q = await createSourcingCandidate(supabase, {
      sourcePlatform: row.source_platform || "",
      sourceQuery: ctx.sourceQuery || "",
      aiScore: Number(row.ai_fit_score) || 0,
      riskScore,
      rankingScore: rank.score,
      decisionReason: `Auto approval threshold not met (${approvalScore} < ${
        approval.threshold
      } or risk ${riskScore} too high or confidence ${approval.confidence} too low).`,
      candidatePayload: {
        row: {
          ...row,
          category,
          name: enriched.name,
          description: enriched.description,
          selling_points: enriched.selling_points,
          seo_meta_title: enriched.seo_meta_title,
          seo_meta_description: enriched.seo_meta_description,
          score: approvalScore,
          style_key: styleKey || "",
          color_variants: [],
        },
      },
    });
    if (!q.ok) return { ok: false, error: q.error || "Queueing candidate failed" };
    await logAi(supabase, "sourcing_candidate_queued", {
      source_platform: row.source_platform || "",
      category,
      name: enriched.name,
      ai_fit_score: Number(row.ai_fit_score) || 0,
      ranking_score: rank.score,
      risk_score: riskScore,
      candidate_id: q.candidate.id,
      cycleId: ctx.cycleId,
      ...(ctx.logExtra || {}),
    });
    return { ok: true, queued: true, candidateId: q.candidate.id };
  }

  const insertRow = {
    ...row,
    category,
    name: enriched.name,
    description: enriched.description,
    selling_points: enriched.selling_points,
    seo_meta_title: enriched.seo_meta_title,
    seo_meta_description: enriched.seo_meta_description,
    score: approvalScore,
    sourcing_status: approval.publish ? "approved" : row.sourcing_status,
    style_key: styleKey || "",
    color_variants: [],
  };
  delete insertRow.popularity_level;
  delete insertRow.recency_level;
  delete insertRow.price_flag;
  delete insertRow.confidence;
  delete insertRow.confidence_score;
  delete insertRow.sold_count;
  delete insertRow.review_count;
  let insertData = null;
  let insertError = null;
  {
    const { data, error } = await supabase.from("products").insert(insertRow).select("id").single();
    insertData = data;
    insertError = error || null;
  }
  if (insertError) {
    const msg = String(insertError.message || "");
    const missingColMatch = msg.match(/Could not find the '([^']+)' column/i);
    if (missingColMatch && missingColMatch[1]) {
      const retryRow = { ...insertRow };
      delete retryRow[missingColMatch[1]];
      const retry = await supabase.from("products").insert(retryRow).select("id").single();
      insertData = retry.data || null;
      insertError = retry.error || null;
    }
  }
  if (insertError) {
    const msg = String(insertError.message || "");
    if (msg.includes("products_external_id_unique") || msg.includes("duplicate key value")) {
      return { ok: false, skip: true };
    }
    return { ok: false, error: insertError.message };
  }
  const data = insertData;
  extSet.add(dedupeKey);
  try {
    const discoveryKey = String(insertRow.external_id || insertRow.source_url || "").trim();
    if (discoveryKey) {
      await supabase
        .from("discovery_product_performance")
        .update({
          product_id: data.id,
          selection_mode: String(insertRow.discovery_mode || "unknown"),
          source_query: String(insertRow.source_query || ""),
          updated_at: new Date().toISOString(),
        })
        .eq("discovery_key", discoveryKey);
    }
  } catch (_) {
    // Observability linkage should not block inserts.
  }
  try {
    const profitSnapshot = computeUnitProfitSnapshot(insertRow, ctx.storeConfig || null);
    await supabase
      .from("products")
      .update({ ...profitSnapshot, updated_at: new Date().toISOString() })
      .eq("id", data.id);
  } catch (_) {
    // Profit columns may not exist before migration is applied.
  }
  await publishEvent(EVENTS.PRODUCT_CREATED, {
    productId: data.id,
    provider: insertRow.source_platform || "unknown",
    category: insertRow.category || "other",
    sourceQuery: ctx.sourceQuery || null,
    mode: ctx.forcePublish ? "admin_approved" : "auto",
  });
  await logAi(supabase, ctx.logAction || "product_added", {
    id: data.id,
    product_id: data.id,
    name: insertRow.name,
    category: insertRow.category,
    price: insertRow.price,
    sourcing_status: insertRow.sourcing_status,
    source_platform: insertRow.source_platform,
    ai_fit_score: insertRow.ai_fit_score,
    brand_fit_reason: insertRow.brand_fit_reason || "",
    cycleId: ctx.cycleId,
    ...(ctx.logExtra || {}),
  });
  const social = await generateSocialPack(
    { name: insertRow.name, brand: insertRow.brand },
    ctx.storeConfig || null
  );
  await supabase
    .from("products")
    .update({
      tiktok_script: social.tiktok_script,
      captions: social.captions,
      hashtags: social.hashtags,
      updated_at: new Date().toISOString(),
    })
    .eq("id", data.id);
  return { ok: true, merged: false, productId: data.id };
}

/**
 * Admin/bulk insert med samme variant-merge og social som sourcing. Genbruger ét external_id-sæt pr. batch.
 */
async function insertProvenanceProductsBatch(supabase, rows, opts = {}) {
  if (!supabase) return { inserted: 0, merged: 0, skipped: 0, errors: [{ error: "Database not configured" }] };
  const externalIds = await loadExternalIdSet(supabase);
  let inserted = 0;
  let merged = 0;
  let queued = 0;
  let skipped = 0;
  const errors = [];
  const logAction = opts.logAction || "product_added";
  const logExtra = opts.logExtra;
  for (const row of rows) {
    const res = await persistSourcedProductRow(supabase, row, externalIds, {
      logAction,
      logExtra,
      storeConfig: opts.storeConfig || null,
      forcePublish: opts.forcePublish !== false,
    });
    if (res.ok) {
      if (res.merged) merged += 1;
      else if (res.queued) queued += 1;
      else inserted += 1;
    } else if (res.skip) skipped += 1;
    else errors.push({ name: row.name, error: res.error || "insert failed" });
  }
  return { inserted, merged, queued, skipped, errors };
}

const SOURCING_CATEGORY_DA = {
  shoes: "sko",
  shirts: "skjorter",
  polos: "poloer",
  trousers: "bukser",
  knitwear: "strik",
  outerwear: "outerwear",
  watches: "ure",
  accessories: "tilbehør",
  toys_dolls: "dukker",
  hobby_paint: "maling",
};

function extractSourcingCategoryIntent(text) {
  return inferIntentCategory(text);
}

function sourcingCategoryIntentLabelDa(categoryId) {
  if (!categoryId) return "";
  return SOURCING_CATEGORY_DA[categoryId] || categoryId;
}

const SOURCING_KEYWORD_STOP = new Set([
  "find",
  "vis",
  "mig",
  "giv",
  "gerne",
  "vil",
  "have",
  "jeg",
  "det",
  "den",
  "der",
  "som",
  "med",
  "til",
  "fra",
  "en",
  "et",
  "og",
  "i",
  "på",
  "bare",
  "også",
  "lige",
  "noget",
  "please",
  "want",
  "show",
  "get",
  "the",
  "a",
  "an",
  "for",
  "me",
  "can",
  "you",
  "fin",
  "fine",
]);

function sourcingKeywordTokens(hintLower) {
  if (!hintLower || hintLower.length < 2) return [];
  const parts = hintLower
    .split(/[^a-z0-9æøåäöü]+/i)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && !SOURCING_KEYWORD_STOP.has(t));
  return [...new Set(parts)];
}

function tokenMatchesTitle(titleLower, tok) {
  if (!tok) return false;
  if (tok === "ur") {
    return /\b(watch|watches|ur|ure|chronograph|timepiece|seconds)\b/i.test(titleLower);
  }
  if (tok.length <= 2) return titleLower.includes(tok);
  try {
    const re = new RegExp(`(?:^|[^a-z0-9æøåäöü])${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z0-9æøåäöü]|$)`, "i");
    return re.test(titleLower);
  } catch {
    return titleLower.includes(tok);
  }
}

function sourcingKeywordHitCount(raw, tokens) {
  if (!tokens.length) return 999;
  const title = String(raw.title || "").toLowerCase();
  let n = 0;
  for (const tok of tokens) {
    if (tokenMatchesTitle(title, tok)) n += 1;
  }
  return n;
}

function minKeywordHitsRequired(tokens) {
  if (!tokens.length) return 0;
  /** Halvt så stramt som 0.65 — undgår at «fin maling» kræver begge ord i titlen. */
  return Math.max(1, Math.ceil(tokens.length * 0.5));
}

/** Ord der kun angiver kategori — allerede håndteret af strict filter / intent. */
const SOURCING_CATEGORY_NOISE = new Set([
  "sko",
  "shoe",
  "shoes",
  "boot",
  "boots",
  "støvle",
  "støvler",
  "loafers",
  "loafer",
  "derby",
  "skjorte",
  "skjorter",
  "shirt",
  "shirts",
  "bukser",
  "trouser",
  "trousers",
  "chino",
  "chinos",
  "jeans",
  "jean",
  "strik",
  "knit",
  "knitwear",
  "sweater",
  "sweaters",
  "cardigan",
  "jakke",
  "jakker",
  "jacket",
  "jackets",
  "coat",
  "coats",
  "outerwear",
  "blazer",
  "frakke",
  "parka",
  "trench",
  "ur",
  "ure",
  "watch",
  "watches",
  "chronograph",
  "timepiece",
  "tilbehør",
  "accessories",
  "bælte",
  "belt",
  "belts",
  "slips",
  "tie",
  "ties",
  "scarf",
  "tørklæde",
]);

function sourcingRefinedKeywordTokens(hintLower) {
  return sourcingKeywordTokens(hintLower).filter((t) => !SOURCING_CATEGORY_NOISE.has(t));
}

function sourcingHintScore(raw, hintLower) {
  if (!hintLower || hintLower.length < 2) return 0;
  const title = String(raw.title || "").toLowerCase();
  const cat = inferCategory(raw.title, raw.category);
  let s = 0;
  const bump = (cond) => {
    if (cond) s += 12;
  };
  bump(/sko|shoe|støvle|boot|loafer|derby|oxford\s+shoe/.test(hintLower) && (cat === "shoes" || /sko|shoe|boot|loafer|derby|støvle/.test(title)));
  bump(/skjorte|shirt|skjorter/.test(hintLower) && (cat === "shirts" || /shirt|skjorte|oxford|poplin/.test(title)));
  bump(/bukser|trouser|chino|jeans?/.test(hintLower) && (cat === "trousers" || /trouser|chino|pant|jean|bukser/.test(title)));
  bump(/strik|knit|sweater|cardigan|merino|cashmere/.test(hintLower) && (cat === "knitwear" || /knit|sweater|cardigan|merino|cashmere|strik/.test(title)));
  bump(/jakke|coat|outerwear|frakke|blazer|parka|trench/.test(hintLower) && (cat === "outerwear" || /jacket|coat|blazer|parka|frakke|overcoat/.test(title)));
  bump(/ur|watch|kronograf|old\s*money|timepiece/.test(hintLower) && (cat === "watches" || /watch|chronograph|timepiece|ur\b/.test(title)));
  bump(/tilbehør|accessories|bælte|belt|tørklæde|scarf|slips|tie/.test(hintLower) && (cat === "accessories" || /belt|scarf|wallet|tie|cufflink|briefcase/.test(title)));
  return s;
}

function rawCandidateCategory(raw) {
  return normalizeCategoryId(inferCategory(raw.title, raw.category));
}

/**
 * Sourcing chat strict gate: titel først — falsk JSON-LD (fx category=Watches på bukser) må ikke omgå filteret.
 */
function categoryGateFromProduct(rawOrTitle) {
  const title = String(rawOrTitle.title != null ? rawOrTitle.title : rawOrTitle || "").trim();
  const hint = rawOrTitle.category != null ? rawOrTitle.category : undefined;
  let c = normalizeCategoryId(inferCategory(title, null));
  if (c !== "other") return c;
  if (hint != null && String(hint).trim()) {
    c = normalizeCategoryId(inferCategory(title, hint));
  }
  return c;
}

/**
 * Discover → evaluate until one non-rejected, non-duplicate candidate (for live sourcing chat).
 * @param {{ categoryIntent?: string | null }} [opts] — when set, only candidates in that category slug (strict).
 */
async function findNextSourcingChatCandidate(supabase, hintText, opts = {}) {
  if (!supabase) return null;
  const storeConfig = opts.storeConfig || (await getStoreConfig(supabase));
  const userMemory = await loadSourcingUserRejects(supabase);
  const categoryIntent = opts.categoryIntent ? normalizeCategoryId(opts.categoryIntent) : null;
  const strict = Boolean(categoryIntent && categoryIntent !== "other");

  const allowedCatalog = new Set(
    Array.isArray(storeConfig.allowedCategories)
      ? storeConfig.allowedCategories.map((x) => normalizeCategoryId(x)).filter(Boolean)
      : []
  );
  if (allowedCatalog.size > 0 && categoryIntent && categoryIntent !== "other" && !allowedCatalog.has(categoryIntent)) {
    return { policyBlock: true, categoryIntent };
  }

  const hintLower = String(hintText || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  const { data: existing } = await supabase.from("products").select("external_id");
  const externalIds = new Set((existing || []).map((r) => r.external_id).filter(Boolean));

  const discoverPool = Math.min(48, Math.max(16, Number(process.env.SOURCING_CHAT_DISCOVER_POOL) || 28));

  const trouserTitleNoise = /chino|chinos|trouser|trousers|denim|\bjean\b|jeans|slack|jogger|cargo\s+pant|bukser|5[-\s]?pocket\s+pant|slim\s+leg\s+straight/i;

  async function evaluateList(rawList) {
    let sorted = [...rawList];
    if (strict) {
      sorted = sorted.filter((r) => categoryGateFromProduct(r) === categoryIntent);
      if (categoryIntent === "shoes") {
        sorted = sorted.filter((r) => !trouserTitleNoise.test(String(r.title || "")));
      }
    }
    const kwRefined = sourcingRefinedKeywordTokens(hintLower);
    // When category intent is strict (e.g. toys_dolls), title-language mismatch (DA query vs EN listings)
    // can wrongly filter out valid candidates. Category gate is enough in this mode.
    const needKw = strict ? 0 : minKeywordHitsRequired(kwRefined);
    if (needKw > 0) {
      sorted = sorted.filter((r) => sourcingKeywordHitCount(r, kwRefined) >= needKw);
    }
    sorted.sort((a, b) => {
      const pa = Number(a.price) > 0 ? Number(a.price) : Number.POSITIVE_INFINITY;
      const pb = Number(b.price) > 0 ? Number(b.price) : Number.POSITIVE_INFINITY;
      if (pa !== pb) return pa - pb;
      return sourcingHintScore(b, hintLower) - sourcingHintScore(a, hintLower);
    });
    for (const raw of sorted) {
      raw._trace = {
        source: String(raw.importMethod || raw.sourcePlatform || ""),
        passedSourceFilter: true,
        passedCategory: true,
        rejectedReason: null,
      };
      const mem = candidateBlockedByUserMemory(raw, userMemory);
      if (mem.blocked) {
        raw._trace.rejectedReason = mem.reason || "user_memory";
        continue;
      }
      if (!rawCandidateAllowedByEnabledSources(raw, storeConfig)) {
        raw._trace.passedSourceFilter = false;
        raw._trace.rejectedReason = "source_policy";
        continue;
      }
      const sourceMeta = {
        sourcePlatform: raw.sourcePlatform || "",
        sourceName: raw.sourceName || "",
        sourceUrl: raw.sourceUrl || "",
        sourceProductId: raw.sourceProductId || raw.externalId || "",
        supplierName: raw.supplierName || "",
        supplierCountry: raw.supplierCountry || "",
        importMethod: raw.importMethod || "",
      };
      const evalResult = await evaluateVeldenSourcing(raw, sourceMeta, {
        storeConfig,
        sourcingChatMode: true,
      });
      if (evalResult.status === "rejected") {
        raw._trace.rejectedReason = evalResult.brandFitReason || "rejected";
        await logAi(supabase, "product_sourcing_rejected", {
          title: evalResult.title,
          reason: evalResult.brandFitReason,
          aiScore: evalResult.aiScore,
          channel: "sourcing_chat",
          meta: { title: evalResult.title || raw.title, trace: { ...raw._trace } },
        });
        continue;
      }
      const verified = categoryGateFromProduct({
        title: evalResult.title || raw.title,
        category: raw.category,
      });
      if (strict && verified !== categoryIntent) {
        raw._trace.passedCategory = false;
        raw._trace.rejectedReason = "category_intent_mismatch";
        continue;
      }

      const dedupeKey = String(evalResult.sourceProductId || raw.externalId || "").trim();
      if (!dedupeKey || externalIds.has(dedupeKey)) {
        raw._trace.rejectedReason = "duplicate_external_id";
        continue;
      }
      return { raw, evalResult };
    }
    return null;
  }

  const strictPasses = strict ? 4 : 1;
  for (let pass = 0; pass < strictPasses; pass++) {
    const pool = Math.min(48, discoverPool + pass * 8);
    const rawList = await discoverProducts(pool, {
      chatMode: true,
      categoryIntent,
      chatSeedRotateIndex: pass,
      storeConfig,
      chatSearchHint: String(hintText || "").trim(),
    });
    const found = await evaluateList(rawList);
    if (found) return found;
  }
  return null;
}

/** Stabil nøgle så chat-preview og DB-insert får samme markup. */
function sourcingMarkupKey(raw, evalResult) {
  return String(
    evalResult.sourceProductId ||
      raw.externalId ||
      evalResult.sourceUrl ||
      raw.sourceUrl ||
      evalResult.title ||
      raw.title ||
      ""
  ).trim() || "velden";
}

function resolvedSourcingCatalogCategory(raw, evalResult) {
  let cat = categoryGateFromProduct({
    title: evalResult.title || raw.title,
    category: raw.category,
  });
  if (cat === "other") {
    cat = normalizeCategoryId(
      evalResult.category || raw.category || inferCategory(evalResult.title || raw.title, raw.category)
    );
  }
  return cat;
}

function formatChatCandidate(raw, evalResult, opts = {}) {
  const sourcePrice = Number(raw.price) || Number(evalResult.price) || 0;
  const key = sourcingMarkupKey(raw, evalResult);
  const veldenShopPrice = priceFromCostDeterministic(sourcePrice, key, null, null);
  const category = resolvedSourcingCatalogCategory(raw, evalResult);
  const intent = opts.categoryIntent ? normalizeCategoryId(opts.categoryIntent) : null;
  const aiScore = Number(evalResult.aiScore) || 0;
  const strictIntent = Boolean(intent && intent !== "other");
  let relevanceLevel = "low";
  let relevanceLabelDa = "Lav";
  let relevanceReason = "Lav AI-score eller svag kategorimatch.";
  if (strictIntent && category === intent && aiScore >= 78) {
    relevanceLevel = "high";
    relevanceLabelDa = "Hoj";
    relevanceReason = "Matcher valgt kategori og har stærk AI-vurdering.";
  } else if (
    (strictIntent && category === intent && aiScore >= 62) ||
    (!strictIntent && aiScore >= 74)
  ) {
    relevanceLevel = "medium";
    relevanceLabelDa = "Mellem";
    relevanceReason = strictIntent
      ? "Matcher valgt kategori, men AI-vurdering er middel."
      : "God AI-vurdering uden strikt kategori-intent.";
  } else if (strictIntent && category !== intent) {
    relevanceLevel = "low";
    relevanceLabelDa = "Lav";
    relevanceReason = "Produktets kategori afviger fra valgt kategori-intent.";
  }
  return {
    name: canonicalProductName(evalResult.title),
    category,
    /** Værdi scrapet fra produktsiden (kostgrundlag / kildepris). På .dk-sider typisk DKK. */
    sourcePrice,
    cost: sourcePrice,
    /** Estimeret Velden-salgspris i samme valuta som kilden (for danske seeds = DKK). */
    veldenShopPrice,
    shopPrice: veldenShopPrice,
    priceCurrency: "DKK",
    aiScore: evalResult.aiScore,
    popularity_level: evalResult.marketplace ? evalResult.marketplace.popularity_level : "unknown",
    recency_level: evalResult.marketplace ? evalResult.marketplace.recency_level : "unknown",
    price_flag: evalResult.marketplace ? evalResult.marketplace.price_flag : "ok",
    confidence: evalResult.marketplace ? evalResult.marketplace.confidence : "medium",
    confidence_score: evalResult.marketplace ? evalResult.marketplace.confidence_score : null,
    sold_count: evalResult.marketplace ? evalResult.marketplace.sold_count : null,
    review_count: evalResult.marketplace ? evalResult.marketplace.review_count : null,
    relevanceLevel,
    relevanceLabelDa,
    relevanceReason,
    categoryIntent: intent || "",
    brandFitReason: evalResult.brandFitReason || "",
    sourcePlatform: evalResult.sourcePlatform || "",
    sourceName: evalResult.sourceName || "",
    sourceUrl: evalResult.sourceUrl || "",
    sourceProductId: evalResult.sourceProductId || "",
    supplierName: evalResult.supplierName || "",
    supplierCountry: evalResult.supplierCountry || "",
    importMethod: evalResult.importMethod || "",
    image: evalResult.image || raw.image || "",
    sourcingStatus: evalResult.status,
  };
}

/**
 * Insert one row after sourcing (skips re-evaluation). Enforces provenance: platform, URL, importMethod.
 */
async function insertApprovedSourcingRow(supabase, raw, evalResult) {
  if (!supabase) return { ok: false, error: "Database not configured" };
  const storeConfig = await getStoreConfig(supabase);
  const cap = Math.floor(Number(storeConfig.maxCatalogProducts) || 0);
  if (cap > 0) {
    const plist = await loadProducts(supabase);
    if (countShopfrontCatalogProducts(plist) >= cap) {
      return {
        ok: false,
        error:
          "Kataloget er ved maks. antal godkendte produkter (Indstillinger). Fjern en vare eller hæv grænsen for at tilføje flere.",
      };
    }
  }
  const plat = String(evalResult.sourcePlatform || "").trim();
  const surl = String(evalResult.sourceUrl || "").trim();
  const im = String(evalResult.importMethod || "").trim();
  if (!plat || !surl || !im) {
    return { ok: false, error: "Provenance required: sourcePlatform, sourceUrl, and importMethod." };
  }
  const normalizedImages = normalizeImages(raw.images || evalResult.images || [evalResult.image], evalResult.image || raw.image);
  if (!normalizedImages.length) {
    return { ok: false, error: "At least one image is required for import." };
  }
  if (evalResult.status === "rejected") {
    return { ok: false, error: "Cannot insert a rejected candidate." };
  }

  const externalIds = await loadExternalIdSet(supabase);
  const dedupeKey = String(evalResult.sourceProductId || raw.externalId || "").trim();
  if (!dedupeKey || externalIds.has(dedupeKey)) {
    return { ok: false, error: "Product already exists in catalogue." };
  }

  const userMemory = await loadSourcingUserRejects(supabase);
  const rawForMem = {
    title: evalResult.title || raw.title,
    sourceUrl: evalResult.sourceUrl || raw.sourceUrl,
    externalId: dedupeKey,
    sourceProductId: dedupeKey,
  };
  const mem = candidateBlockedByUserMemory(rawForMem, userMemory);
  if (mem.blocked) {
    await logAi(supabase, "sourcing_skipped_user_memory", {
      title: rawForMem.title,
      reason: mem.reason,
      similarity: mem.similarity,
      channel: "sourcing_chat",
    });
    return { ok: false, error: "Denne type vare har du fjernet før — den bliver ikke indsat igen." };
  }

  const cost = Number(raw.price) || Number(evalResult.price) || 99;
  const copy = evalResult.description
    ? {
        brand: "Velden",
        description: evalResult.description,
        selling_points: "Quiet luxury | Considered make | Tidløs herrelinje",
      }
    : await generateProductCopy(evalResult.title, cost, storeConfig);
  const priceKey = sourcingMarkupKey(raw, evalResult);
  const pricing = computeOptimalPrice(
    {
      supplier_price: cost,
      market_price: Number(raw.price) || Number(evalResult.price) || 0,
      estimated_shipping_cost: estimateShippingCost({ cost, category: evalResult.category || raw.category || "other" }, storeConfig),
      popularity_score: evalResult.marketplace ? evalResult.marketplace.popularity_score : null,
      confidence: evalResult.marketplace ? evalResult.marketplace.confidence : "medium",
    },
    {
      goal:
        (storeConfig && (storeConfig.goal || (storeConfig.strategy && storeConfig.strategy.goal))) || "profit",
    }
  );
  const price =
    Number(pricing.suggested_price) || priceFromCostDeterministic(cost, priceKey, null, storeConfig);
  const category = resolvedSourcingCatalogCategory(raw, evalResult);
  const color = raw.color || inferProductColor(evalResult.title);
  const normalizedVariants = normalizeVariants(raw.variants || evalResult.variants, {
    size: raw.sizes ? String(raw.sizes).split(",")[0] : "unknown",
    color,
    price,
    available: raw.available !== false,
  });
  const sizes = summarizeSizesFromVariants(normalizedVariants);
  const row = {
    name: evalResult.title.slice(0, 200),
    cost,
    price,
    score: 0,
    status: "active",
    sourcing_status: evalResult.status,
    brand: copy.brand,
    description: copy.description,
    selling_points: copy.selling_points,
    image_url: normalizedImages[0] || evalResult.image,
    image_urls: normalizedImages,
    external_id: dedupeKey,
    category,
    color: inferPrimaryColorFromVariants(normalizedVariants, color),
    sizes,
    supplier_variants: normalizedVariants,
    available: hasAvailableVariant(normalizedVariants),
    availability_reason: hasAvailableVariant(normalizedVariants) ? "" : "supplier_out_of_stock",
    supplier_last_checked_at: new Date().toISOString(),
    source_platform: evalResult.sourcePlatform || "",
    source_name: evalResult.sourceName || "",
    source_url: evalResult.sourceUrl || "",
    source_query: String(raw.sourceQuery || evalResult.sourceQuery || "").trim(),
    source_product_id: evalResult.sourceProductId || "",
    supplier_name: evalResult.supplierName || "",
    supplier_country: evalResult.supplierCountry || "",
    import_method: evalResult.importMethod || "",
    discovery_mode: String(raw.discovery_selection_mode || "exploit"),
    ai_fit_score: evalResult.aiScore,
    brand_fit_reason: evalResult.brandFitReason || "",
  };
  row.ai_fit_score = Math.max(0, Math.min(100, Math.round(Number(row.ai_fit_score) || 0)));

  const res = await persistSourcedProductRow(supabase, row, externalIds, {
    logExtra: { channel: "sourcing_chat" },
    storeConfig,
    forcePublish: true,
  });
  if (!res.ok) {
    if (res.skip) return { ok: false, error: "Product already exists in catalogue." };
    return { ok: false, error: res.error || "Insert failed" };
  }

  const outName = canonicalProductName(row.name);
  return {
    ok: true,
    productId: res.productId,
    name: outName,
    mergedVariant: Boolean(res.merged),
  };
}

async function buildPerformanceSummary(supabase) {
  if (!supabase) return null;
  const { data, error } = await visibleOnShopfront(
    supabase.from("products").select("id, name, score, status")
  ).neq("status", "removed");
  if (error || !data?.length) {
    return { activeCount: error ? 0 : data?.length || 0, avgScore: 0, topProduct: null };
  }
  const scores = data.map((p) => Number(p.score) || 0);
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const top = [...data].sort((a, b) => Number(b.score) - Number(a.score))[0];
  return {
    activeCount: data.length,
    avgScore: Math.round(avgScore * 100) / 100,
    topProduct: top ? { id: top.id, name: top.name, score: Number(top.score) || 0 } : null,
  };
}

function buildPerformanceSummaryFromProducts(products) {
  const rows = (products || []).filter((p) => p && p.id && p.status !== "removed");
  if (!rows.length) return { activeCount: 0, avgScore: 0, topProduct: null };
  const scores = rows.map((p) => Number(p.score) || 0);
  const avgScore = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
  const top = [...rows].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))[0];
  return {
    activeCount: rows.length,
    avgScore: Math.round(avgScore * 100) / 100,
    topProduct: top ? { id: top.id, name: top.name, score: Number(top.score) || 0 } : null,
  };
}

async function enrichContentForProducts(supabase, ids, cycleId) {
  const uniq = [...new Set(ids || [])];
  for (const id of uniq) {
    const { data: p } = await supabase.from("products").select("*").eq("id", id).single();
    if (!p || p.status === "removed") continue;
    const lowEngagement = (Number(p.views) || 0) > 20 && (Number(p.clicks) || 0) < 2;
    const missingContent =
      !p.tiktok_script || !p.captions || !p.hashtags || String(p.tiktok_script || "").length < 20;
    if (!lowEngagement && !missingContent) continue;
    const social = await generateSocialPack(p);
    await supabase
      .from("products")
      .update({
        tiktok_script: social.tiktok_script,
        captions: social.captions,
        hashtags: social.hashtags,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    await logAi(supabase, "content_regenerated", { productId: id, product_id: id, name: p.name, cycleId });
  }
}

/**
 * Full AI + catalog cycle. Safe to call without Supabase (no-op with error in state).
 */
async function runAutomationCycle(supabase, opts = {}) {
  if (ceoAutomationPaused) {
    return;
  }
  if (state.running) return;
  const ceoMode = normalizeCeoCycleMode(opts && opts.mode);
  const dryRun = Boolean(opts && opts.dryRun);
  state.running = true;
  state.lastError = null;
  state.productsAddedLastRun = 0;
  state.productsRemovedLastRun = 0;
  state.decisionsLastRun = [];
  state.performanceSummary = null;
  const cycleId = randomUUID();
  logger.info("automation.cycle.start", { cycleId });
  const lockKey = "automation:ceo-cycle";
  let hasLock = false;
  let rollbackSnapshot = [];

  try {
    if (state.circuitBreaker.tripped) {
      state.lastError = `Circuit breaker active: ${state.circuitBreaker.reason || "manual reset required"}`;
      return;
    }
    if (!supabase) {
      state.lastError = "Supabase not configured";
      return;
    }
    hasLock = await acquireLock(supabase, lockKey);
    if (!hasLock) return;

    const storeConfig = await getStoreConfig(supabase);
    let products = await loadProducts(supabase);
    await syncScores(supabase, products);
    products = await loadProducts(supabase);
    const businessMetrics = computeStoreMetrics(products);
    const trendData = await getLastNDaysTrends(supabase, 14);
    const objective = computeObjective(businessMetrics);
    const tuned = tuneParametersFromTrends(trendData);
    const strategyState = computeStrategyState(products, tuned);
    const experimentResults = evaluateExperimentResults(products);
    const recentDecisions = await loadRecentDecisions(supabase, 40);
    const attributionResults = { lastCycle: null };
    const categoryLearningMap = await loadCategoryLearningMap(supabase);
    if (experimentResults.winner) {
      await logAi(supabase, "experiment_evaluated", {
        cycleId,
        winner: experimentResults.winner,
        loser: experimentResults.loser,
        reason: "ab_variant_profit_comparison",
      });
      if (/^1|true|yes$/i.test(String(process.env.AUTO_PROMOTE_EXPERIMENTS || ""))) {
        await supabase
          .from("products")
          .update({ experiment_variant: experimentResults.winner })
          .is("experiment_variant", null);
      }
      await recordDecision(supabase, {
        cycle_id: cycleId,
        decision_type: "experiment_promotion",
        hypothesis: "Promote winning variant to improve conversion and profit.",
        expected_effect: "better experiment ROI",
        confidence: 0.66,
        before_state: { winner: experimentResults.winner, loser: experimentResults.loser },
        after_state: { promoted: /^1|true|yes$/i.test(String(process.env.AUTO_PROMOTE_EXPERIMENTS || "")) },
      });
      const exp = await startExperiment(supabase, {
        experiment_key: `variant-${cycleId}`,
        variant_a: "A",
        variant_b: "B",
        context: { cycleId },
      });
      if (exp && shouldCloseExperiment(exp, { sampleSize: experimentResults.groups.A.count + experimentResults.groups.B.count })) {
        await closeExperiment(supabase, exp.id, experimentResults.winner, "sufficient_evidence");
        await archiveExperimentResult(supabase, {
          experiment_id: exp.id,
          winner_variant: experimentResults.winner,
          loser_variant: experimentResults.loser,
          evidence: experimentResults,
        });
      }
    }

    const memories = await loadMemories(supabase);
    const shopReadyBeforePlan = countShopfrontCatalogProducts(products);
    await logAi(supabase, "ceo_phase_read", { cycleId, phase: "READ" });
    const plan = await decideWithGemini({
      products,
      memories,
      businessMetrics,
      trendData,
      objective: mapStoreStrategyToCeoObjective(storeConfig),
      constraints: {
        minMargin: Number(process.env.KILL_SWITCH_MIN_MARGIN || 0.18),
        maxCategoryShare: Number(process.env.MAX_CATEGORY_SHARE || 0.4),
        stability: tuned.stability || "normal",
        risk: String((storeConfig.strategy && storeConfig.strategy.risk) || "balanced"),
      },
      experimentResults,
      recentDecisions,
      attributionResults,
      categoryLearning: Object.fromEntries(categoryLearningMap),
      storeConfig: {
        brand: storeConfig.brand,
        tone: storeConfig.tone,
        positioning: storeConfig.positioning,
        strategy: storeConfig.strategy,
        maxCatalogProducts: storeConfig.maxCatalogProducts || 0,
        catalogProductCount: shopReadyBeforePlan,
      },
    });
    logger.info("automation.cycle.ai_decision_received", {
      cycleId,
      removeCount: Array.isArray(plan && plan.removeProductIds) ? plan.removeProductIds.length : 0,
      scaleCount: Array.isArray(plan && plan.scaleProductIds) ? plan.scaleProductIds.length : 0,
      priceCount: Array.isArray(plan && plan.priceUpdates) ? plan.priceUpdates.length : 0,
    });
    await logAi(supabase, "ceo_phase_plan", { cycleId, phase: "PLAN" });
    const rulePlan = createDeterministicPlan(enforceBusinessRules(plan, products));
    const elasticityByCategory = {};
    const cats = [...new Set(products.map((p) => String(p.category || "other")))];
    for (const c of cats) {
      elasticityByCategory[c] = await elasticityMultiplierForCategory(supabase, c);
    }
    const strategyUpdates = adjustPricesForAOV(products, businessMetrics, {
      pricingAggressiveness: tuned.pricingAggressiveness,
      elasticityByCategory,
      targetMargin: storeConfig.targetMargin,
      priceRange: storeConfig.priceRange,
    });
    rulePlan.priceUpdates = deterministicPriceAdjustments([...(rulePlan.priceUpdates || []), ...strategyUpdates]);
    rulePlan.priceAdjustments = rulePlan.priceUpdates;
    const adaptMult = await loadRiskAdaptMultiplier(supabase);
    Object.assign(
      rulePlan,
      enforceRiskCapsOnPlan(rulePlan, products, storeConfig.strategy && storeConfig.strategy.risk, {
        adaptMultiplier: adaptMult,
      })
    );
    const targetState = buildTargetStatePlan(products, storeConfig);
    const preValidatedPlan = createDeterministicPlan({
      ...rulePlan,
      addProducts: Math.max(Number(rulePlan.addProducts) || 0, Number(targetState.plan.addProducts) || 0),
      removeProductIds: deterministicUniqueSortedIds([
        ...(rulePlan.removeProductIds || []),
        ...(targetState.plan.removeProductIds || []),
      ]),
    });
    await logAi(supabase, "ceo_plan_raw", {
      cycleId,
      dryRun,
      plan: preValidatedPlan,
      targetState: {
        targetActive: targetState.targetActive,
        targetMaxInactive: targetState.targetMaxInactive,
        activeCount: targetState.activeCount,
        inactiveCount: targetState.inactiveCount,
      },
    });
    const validatedPlan = validatePlan(preValidatedPlan, Object.fromEntries(products.map((p) => [p.id, p])), storeConfig, state);
    if (!validatedPlan.ok) {
      state.lastPlan = null;
      await logAi(supabase, "ceo_plan_rejected", {
        cycleId,
        dryRun,
        reason: validatedPlan.reason,
        violations: validatedPlan.violations,
      });
      return;
    }
    const safePlan = validatedPlan.safePlan;
    await logAi(supabase, "ceo_plan_validated", {
      cycleId,
      dryRun,
      safePlan,
      validation: { ok: true, violations: [] },
    });
    const sourceMetricsMap = await loadSourceMetricsMap(supabase);
    for (const [srcName, srcMetric] of sourceMetricsMap.entries()) {
      const w = sourceDiscoveryWeight(srcMetric);
      if (Math.abs(w - 1) < 0.2) continue;
      await recordDecision(supabase, {
        cycle_id: cycleId,
        decision_type: "source_weighting",
        source_name: srcName,
        hypothesis: "Adjusting discovery weight by source quality should improve candidate yield.",
        expected_effect: "better source mix",
        confidence: 0.58,
        before_state: { success_rate: srcMetric.success_rate, avg_profit: srcMetric.avg_profit },
        after_state: { discovery_weight: w },
      });
    }
    await logAi(supabase, "ceo_phase_validate", { cycleId, phase: "VALIDATE" });
    state.lastPlan = {
      removeProductIds: safePlan.removeProductIds,
      scaleProductIds: safePlan.scaleProductIds,
      priceUpdates: safePlan.priceUpdates,
      addProducts: safePlan.addProducts,
      contentTargets: safePlan.contentTargets,
      insights: safePlan.insights,
    };

    const removeThreshold = Math.max(
      4,
      Math.floor(
        products.filter((p) => p.status !== "removed").length *
          0.35 *
          Number(tuned.removalThresholdFactor || 1)
      )
    );
    const tooManyPriceChanges = (safePlan.priceUpdates || []).length > 30;
    if ((safePlan.removeProductIds || []).length > removeThreshold || tooManyPriceChanges) {
      ceoAutomationPaused = true;
      state.lastError = "Safety kill-switch triggered: automation paused.";
      await logAi(supabase, "cycle_safety_kill_switch", {
        cycleId,
        removeCount: (safePlan.removeProductIds || []).length,
        priceChangeCount: (safePlan.priceUpdates || []).length,
      });
      await persistRiskAdaptation(
        supabase,
        computeNextAdaptation(storeConfig.riskAdaptation, "kill_switch")
      );
      return;
    }

    const prevProfit = trendData && trendData[0] ? Number(trendData[0].profit) || 0 : null;
    const currProfit = Number(businessMetrics.totalProfit) || 0;
    const profitDrop = prevProfit != null && prevProfit > 0 ? (prevProfit - currProfit) / prevProfit : 0;
    const marginTooLow = Number(businessMetrics.avgMargin) < Number(process.env.KILL_SWITCH_MIN_MARGIN || 0.18);
    if (profitDrop > Number(process.env.KILL_SWITCH_MAX_PROFIT_DROP || 0.3) || marginTooLow) {
      ceoAutomationPaused = true;
      state.lastError = "Profit-based kill-switch triggered: automation paused.";
      await logAi(supabase, "cycle_profit_kill_switch", {
        cycleId,
        prevProfit,
        currProfit,
        profitDrop,
        avgMargin: businessMetrics.avgMargin,
      });
      await persistRiskAdaptation(
        supabase,
        computeNextAdaptation(storeConfig.riskAdaptation, "profit_kill")
      );
      return;
    }

    const byId = Object.fromEntries(products.map((p) => [p.id, p]));
    const affectedIds = [
      ...(safePlan.removeProductIds || []),
      ...(safePlan.scaleProductIds || []),
      ...(safePlan.priceUpdates || []).map((x) => x.id),
    ];
    rollbackSnapshot = await snapshotProducts(supabase, affectedIds);
    await logAi(supabase, "ceo_phase_execute", { cycleId, phase: "EXECUTE" });
    const applied = await applyPlan(supabase, { ...safePlan, __dryRun: dryRun }, byId, cycleId);
    logger.info("automation.cycle.db_writes_applied", { cycleId, appliedCount: applied.length });
    state.decisionsLastRun = applied;
    state.productsRemovedLastRun = applied.filter((d) => d.type === "deactivate").length;

    const activeCount = dryRun ? countShopfrontCatalogProducts(products) : countShopfrontCatalogProducts(await loadProducts(supabase));
    const aiAddsRaw = safePlan.addCount != null ? safePlan.addCount : safePlan.addProducts;
    let targetAdds = desiredNewImportCount(activeCount, aiAddsRaw, storeConfig.maxCatalogProducts);
    if (ceoMode === "light") {
      targetAdds = 0;
      state.sourcingLastDiscovery = {
        status: "skipped",
        reason: "ceo_light_mode",
        meta: { cycleId, ceoMode, note: "Discovery/import skipped in light CEO cycle (use background sourcing)." },
      };
      logger.info("automation.cycle.discovery_skipped", { cycleId, ceoMode });
    }
    if (targetAdds > 0 && !dryRun) {
      const sourcingStoreConfig = await getStoreConfig(supabase);
      const sourcingRunId = randomUUID();
      const discoveryLog = makeDiscoveryLogger(supabase, cycleId);
      const discovered = await discoverProductsDetailed(targetAdds + 2, {
        supabase,
        storeConfig: sourcingStoreConfig,
        runId: sourcingRunId,
        cycleId,
        discoveryLog,
      });
      state.sourcingLastDiscovery = {
        status: discovered.status,
        reason: discovered.reason,
        meta: discovered.meta,
      };
      const raw = discovered.candidates || [];
      console.log("STEP:", "runAutomationCycle.discovery", {
        count: raw.length,
        status: discovered.status,
        reason: discovered.reason,
      });
      const insRes = await insertEnrichedProducts(
        supabase,
        raw,
        targetAdds,
        cycleId,
        strategyState,
        sourcingStoreConfig,
        sourcingRunId
      );
      state.productsAddedLastRun = insRes.inserted;
      console.log("INSERTED PRODUCTS:", Number(insRes.inserted) || 0);
    }

    const contentIds = [...new Set([...(safePlan.contentProductIds || []), ...(safePlan.promoteProductIds || [])])];
    if (!dryRun && contentIds.length) await enrichContentForProducts(supabase, contentIds, cycleId);

    if (!dryRun) await saveMemories(supabase, safePlan.insights);
    state.performanceSummary = dryRun ? buildPerformanceSummaryFromProducts(products) : await buildPerformanceSummary(supabase);
    const productsAfter = dryRun ? products : await loadProducts(supabase);
    if (!dryRun) {
      await backfillElasticityOutcomes(supabase, Object.fromEntries(productsAfter.map((p) => [p.id, p])));
      await recordDailyMetrics(supabase, productsAfter);
      await recordLearningMetrics(supabase, productsAfter);
      await updateSourceMetrics(supabase, productsAfter);
      await rebuildCategoryLearning(supabase, productsAfter);
    }
    const afterMetrics = computeStoreMetrics(productsAfter);
    const profitDelta = evaluateDelta(businessMetrics, afterMetrics);
    const attributionResultsComputed = attributeCycleOutcome(businessMetrics, afterMetrics, applied);
    const stabilityPenalty =
      Math.abs(Number(tuned.pricingAggressiveness || 1) - 1) * 20 +
      Math.abs(Number(tuned.removalThresholdFactor || 1) - 1) * 15;
    const decisionQuality = computeDecisionQualityScore({
      profitDelta: attributionResultsComputed.profitDelta,
      marginDelta: attributionResultsComputed.marginDelta,
      conversionDelta: attributionResultsComputed.conversionDelta,
      stabilityPenalty,
      rollbackTriggered: false,
    });
    try {
      await supabase.from("cycle_outcomes").upsert(
        {
          cycle_id: cycleId,
          profit_delta: attributionResultsComputed.profitDelta,
          conversion_delta: attributionResultsComputed.conversionDelta,
          margin_delta: attributionResultsComputed.marginDelta,
          decision_quality_score: decisionQuality,
          stability_penalty: stabilityPenalty,
          rollback_penalty: 0,
          created_at: new Date().toISOString(),
        },
        { onConflict: "cycle_id" }
      );
    } catch (e) {
      logger.warn("automation.cycle_outcomes.upsert_failed", {
        cycleId,
        error: e && e.message ? e.message : String(e),
      });
    }
    await logAi(supabase, "cycle_outcome", {
      cycleId,
      objective,
      profit_delta: attributionResultsComputed.profitDelta,
      conversion_delta: attributionResultsComputed.conversionDelta,
      margin_delta: attributionResultsComputed.marginDelta,
      decision_quality: decisionQuality,
      before: businessMetrics,
      after: afterMetrics,
      attribution: attributionResultsComputed.attributions,
      reason: "post_cycle_outcome_evaluation",
      ai_confidence: Math.min(1, Math.max(0, (decisionQuality || 0) / 100)),
    });

    try {
      const cfgPost = await getStoreConfig(supabase);
      await persistRiskAdaptation(
        supabase,
        computeNextAdaptation(cfgPost.riskAdaptation, "applied_ok", { decisionQuality })
      );
    } catch (e) {
      logger.warn("automation.risk_adaptation.persist_skipped", {
        cycleId,
        error: e && e.message ? e.message : String(e),
      });
    }

    await logAi(supabase, "ceo_phase_log", { cycleId, phase: "LOG" });
    await logAi(supabase, "cycle_complete", {
      cycleId,
      dryRun,
      deactivateProductIds: (safePlan.removeProductIds || []).length,
      scaleProductIds: (safePlan.scaleProductIds || []).length,
      priceUpdates: (safePlan.priceUpdates || []).length,
      addProducts: safePlan.addProducts,
      contentTargets: (safePlan.contentTargets || []).length,
      inserted: state.productsAddedLastRun,
      insights: (safePlan.insights || []).length,
    });
    await logAi(supabase, "ceo_execution_audit", {
      cycleId,
      dryRun,
      executedActions: applied,
      validation: { ok: true },
      targetState: buildTargetStatePlan(productsAfter, storeConfig),
    });
    await logAi(supabase, "ceo_phase_pause", {
      cycleId,
      phase: "PAUSE",
      nextCycleInMs: CEO_INTERVAL_MS,
    });
    state.circuitBreaker.errorStreak = 0;
  } catch (e) {
    state.lastError = e.message || String(e);
    state.circuitBreaker.errorStreak = Number(state.circuitBreaker.errorStreak || 0) + 1;
    if (state.circuitBreaker.errorStreak >= CEO_ERROR_STREAK_LIMIT) {
      state.circuitBreaker.tripped = true;
      state.circuitBreaker.reason = state.lastError;
      state.circuitBreaker.trippedAt = new Date().toISOString();
      ceoAutomationPaused = true;
    }
    logger.error("automation.cycle.error", {
      cycleId,
      error: state.lastError,
      stack: e && e.stack ? e.stack : null,
    });
    try {
      if (rollbackSnapshot.length) await restoreProducts(supabase, rollbackSnapshot);
      try {
        await supabase.from("cycle_outcomes").upsert(
          {
            cycle_id: cycleId,
            profit_delta: null,
            conversion_delta: null,
            margin_delta: null,
            decision_quality_score: 0,
            stability_penalty: 0,
            rollback_penalty: 100,
            created_at: new Date().toISOString(),
          },
          { onConflict: "cycle_id" }
        );
      } catch (e2) {
        logger.warn("automation.cycle_outcomes.rollback_penalty_failed", {
          cycleId,
          error: e2 && e2.message ? e2.message : String(e2),
        });
      }
    } catch (_) {
      logger.error("automation.rollback.failed", { cycleId });
    }
    try {
      if (supabase) await logAi(supabase, "cycle_error", { error: state.lastError, cycleId });
    } catch (_) {
      logger.warn("automation.cycle_error.log_failed", { cycleId });
    }
    try {
      if (supabase) {
        const cfgE = await getStoreConfig(supabase);
        await persistRiskAdaptation(
          supabase,
          computeNextAdaptation(cfgE.riskAdaptation, "cycle_error")
        );
      }
    } catch (_) {
      /* best-effort */
    }
  } finally {
    if (hasLock && supabase) await releaseLock(supabase, lockKey);
    state.lastRunAt = new Date().toISOString();
    state.running = false;
    logger.info("automation.cycle.end", {
      cycleId,
      error: state.lastError || null,
      added: state.productsAddedLastRun,
      removed: state.productsRemovedLastRun,
    });
  }
}

/**
 * Lightweight pass: discover candidates → brand-fit → insert (no CEO / no score sync).
 * Skips while the full CEO automation cycle is running to avoid overlapping API/DB work.
 */
async function runSourcingPass(supabase, opts = {}) {
  function blocked(reasonCode) {
    const code = String(reasonCode || NO_PRODUCTS_REASON.UNKNOWN);
    const status = "no_results";
    const payload = { ok: false, status, reason: code, noProducts: { code, message: noProductsReasonMessage(code) } };
    state.sourcingLastDiscovery = { status, reason: code, meta: { noProducts: payload.noProducts } };
    return payload;
  }
  console.log("STEP:", "runSourcingPass.start", { count: 0, status: "running", reason: null });
  if (!supabase) {
    console.log("STEP:", "runSourcingPass.blocked", { count: 0, status: "no_results", reason: NO_PRODUCTS_REASON.DB_UNAVAILABLE });
    return blocked(NO_PRODUCTS_REASON.DB_UNAVAILABLE);
  }
  if (SOURCING_DISABLED) {
    console.log("STEP:", "runSourcingPass.blocked", { count: 0, status: "no_results", reason: NO_PRODUCTS_REASON.PROVIDER_OFF });
    return blocked(NO_PRODUCTS_REASON.PROVIDER_OFF);
  }
  /** Samme pause som CEO-cyklus — ellers kører discovery/import videre i baggrunden. */
  if (isCeoAutomationPaused() && !(opts && opts.ignorePause)) {
    console.log("STEP:", "runSourcingPass.blocked", { count: 0, status: "no_results", reason: NO_PRODUCTS_REASON.AUTOMATION_PAUSED });
    return blocked(NO_PRODUCTS_REASON.AUTOMATION_PAUSED);
  }
  if (state.running && !(opts && opts.ignoreBusy)) {
    console.log("STEP:", "runSourcingPass.blocked", { count: 0, status: "no_results", reason: NO_PRODUCTS_REASON.AUTOMATION_BUSY });
    return blocked(NO_PRODUCTS_REASON.AUTOMATION_BUSY);
  }
  if (state.sourcingRunning && !(opts && opts.ignoreBusy)) {
    console.log("STEP:", "runSourcingPass.blocked", { count: 0, status: "no_results", reason: NO_PRODUCTS_REASON.SOURCING_BUSY });
    return blocked(NO_PRODUCTS_REASON.SOURCING_BUSY);
  }

  state.sourcingRunning = true;
  state.sourcingLastError = null;
  const cycleId = randomUUID();
  const dryRun = Boolean(opts && opts.dryRun);
  logger.info("automation.sourcing.start", { cycleId });
  const lockKey = opts && opts.ignoreBusy ? "automation:sourcing-pass:manual" : "automation:sourcing-pass";
  let hasLock = false;
  try {
    if (dryRun) {
      const storeConfig = await getStoreConfig(supabase);
      const products = await loadProducts(supabase);
      const trendData = await getLastNDaysTrends(supabase, 7);
      const tuned = tuneParametersFromTrends(trendData);
      const strategyState = computeStrategyState(products, tuned);
      const shopReady = countShopfrontCatalogProducts(products);
      const cap = Math.floor(Number(storeConfig.maxCatalogProducts) || 0);
      const room = cap > 0 ? Math.max(0, cap - shopReady) : Math.max(10, Number(opts.targetCount) || 12);
      const cycleCap = Math.max(10, Math.min(20, Number((opts && opts.perCycleLimit) || process.env.SOURCING_PER_CYCLE_LIMIT || 12)));
      const target = Math.min(Math.max(1, Number(opts.targetCount) || cycleCap), cycleCap, room || cycleCap);
      const queryPack = generateCategoryQueryPack({
        storeConfig,
        categoryIntent: opts.categoryIntent || null,
        chatSearchHint: opts.chatSearchHint || "",
      });
      const queries = (queryPack.packs || [])
        .flatMap((p) => (p.variants || []).map((v) => String(v.query || "").trim()))
        .filter(Boolean)
        .slice(0, 80);
      const discovered = await discoverProductsDetailed(target + 4, {
        supabase,
        storeConfig,
        cycleId,
        chatSearchHint: opts.chatSearchHint || "",
        categoryIntent: opts.categoryIntent || null,
      });
      state.sourcingLastDiscovery = {
        status: discovered.status,
        reason: discovered.reason,
        meta: discovered.meta,
      };
      const raw = discovered.candidates || [];
      console.log("STEP:", "runSourcingPass.discovery", {
        count: raw.length,
        status: discovered.status,
        reason: discovered.reason,
      });
      const insRes = await insertEnrichedProducts(
        supabase,
        raw,
        target,
        cycleId,
        strategyState,
        storeConfig,
        null,
        { dryRun: true }
      );
      return {
        ok: true,
        dryRun: true,
        queries,
        candidates: insRes.candidates || [],
        trends: insRes.trends || [],
        boostedProducts: insRes.boostedProducts || [],
        learning: insRes.learning || { topKeywords: [], avoidedKeywords: [], categoriesBoosted: [] },
        discovery: {
          status: discovered.status,
          reason: discovered.reason,
          meta: discovered.meta,
        },
        totalFound: Number(insRes.totalFound) || 0,
        afterFiltering: Number(insRes.afterFiltering) || 0,
        rejectedCount: Number(insRes.rejectedCount) || 0,
        reasonsBreakdown: insRes.reasonsBreakdown || {},
        wouldInsert: Number(insRes.wouldInsert) || 0,
        target,
        activeBefore: shopReady,
        cap,
      };
    }
    if (opts && opts.ignoreBusy) {
      hasLock = false;
    } else {
      const lockTtlMs =
        Number((opts && opts.lockTtlMs) || 0) > 0
          ? Math.max(30_000, Number(opts.lockTtlMs))
          : Math.max(45_000, Math.floor(SOURCING_INTERVAL_MS * 0.8));
      hasLock = await acquireLock(supabase, lockKey, lockTtlMs);
      if (!hasLock) return blocked(NO_PRODUCTS_REASON.LOCK_BUSY);
    }
    const storeConfig = await getStoreConfig(supabase);
    const products = await loadProducts(supabase);
    const trendData = await getLastNDaysTrends(supabase, 7);
    const tuned = tuneParametersFromTrends(trendData);
    const strategyState = computeStrategyState(products, tuned);
    const shopReady = countShopfrontCatalogProducts(products);
    const cap = Math.floor(Number(storeConfig.maxCatalogProducts) || 0);
    if (cap > 0 && shopReady >= cap) {
      logger.info("automation.sourcing.skip_at_cap", { cycleId, shopReady, cap });
      try {
        await logAi(supabase, "sourcing_pass_skipped", {
          cycleId,
          reason: "max_catalog_products",
          shopReady,
          cap,
        });
      } catch {
        /* ignore */
      }
      state.sourcingLastInserted = 0;
      state.sourcingLastRunAt = new Date().toISOString();
      state.sourcingLastDiscovery = {
        status: "no_results",
        reason: "at_capacity",
        meta: { providerBreakdown: {}, counts: { requested: 0, discovered: 0, activeProviders: 0 } },
      };
      console.log("STEP:", "runSourcingPass.blocked", { count: 0, status: "no_results", reason: NO_PRODUCTS_REASON.AT_CAPACITY });
      return blocked(NO_PRODUCTS_REASON.AT_CAPACITY);
    }
    let target =
      shopReady < 8
        ? Math.min(6, Math.max(SOURCING_BATCH_SIZE, 4 - Math.min(shopReady, 3)))
        : SOURCING_BATCH_SIZE;
    if (opts && opts.targetCount != null) {
      target = Math.max(1, Math.floor(Number(opts.targetCount) || target));
    }
    const cycleCap = Math.max(10, Math.min(20, Number((opts && opts.perCycleLimit) || process.env.SOURCING_PER_CYCLE_LIMIT || 12)));
    target = Math.min(target, cycleCap);
    if (cap > 0) target = Math.min(target, Math.max(0, cap - shopReady));
    if (target <= 0) {
      logger.info("automation.sourcing.skip_no_room", { cycleId, shopReady, cap });
      state.sourcingLastInserted = 0;
      state.sourcingLastRunAt = new Date().toISOString();
      state.sourcingLastDiscovery = {
        status: "no_results",
        reason: "at_capacity",
        meta: { providerBreakdown: {}, counts: { requested: 0, discovered: 0, activeProviders: 0 } },
      };
      console.log("STEP:", "runSourcingPass.blocked", { count: 0, status: "no_results", reason: NO_PRODUCTS_REASON.AT_CAPACITY });
      return blocked(NO_PRODUCTS_REASON.AT_CAPACITY);
    }
    const sourcingRunId = randomUUID();
    const discoveryLog = makeDiscoveryLogger(supabase, cycleId);
    const discovered = await discoverProductsDetailed(target + 4, {
      supabase,
      storeConfig,
      runId: sourcingRunId,
      cycleId,
      discoveryLog,
    });
    state.sourcingLastDiscovery = {
      status: discovered.status,
      reason: discovered.reason,
      meta: discovered.meta,
    };
    const raw = discovered.candidates || [];
    console.log("STEP:", "runSourcingPass.discovery", {
      count: raw.length,
      status: discovered.status,
      reason: discovered.reason,
    });
    const insRes = await insertEnrichedProducts(
      supabase,
      raw,
      target,
      cycleId,
      strategyState,
      storeConfig,
      sourcingRunId
    );
    state.sourcingLastInserted = insRes.inserted;
    state.sourcingLastRunAt = new Date().toISOString();
    await logAi(supabase, "sourcing_pass_complete", {
      cycleId,
      inserted: insRes.inserted,
      candidatesSeen: raw.length,
      target,
      rejectedCount: insRes.rejectedCount,
      skippedSourcePolicy: insRes.skippedBySourcePolicy,
      skippedCategoryCap: insRes.skippedByCategoryCount,
      qualifiedAfterAi: insRes.qualifiedCount,
      discoveryStatus: discovered.status,
      discoveryReason: discovered.reason,
      approvedCount: insRes.approvedCount,
    });
    logger.info("automation.sourcing.end", {
      cycleId,
      inserted: insRes.inserted,
      candidatesSeen: raw.length,
      target,
    });
    const productsAfter = await loadProducts(supabase);
    await updateSourceMetrics(supabase, productsAfter);
    await recordLearningMetrics(supabase, productsAfter);
    return {
      ok: true,
      discovery: {
        status: discovered.status,
        reason: discovered.reason,
        meta: discovered.meta,
      },
      noProducts:
        discovered.status === "no_results"
          ? {
              code: String(discovered.reason || NO_PRODUCTS_REASON.UNKNOWN),
              message: noProductsReasonMessage(discovered.reason),
            }
          : null,
      inserted: insRes.inserted,
      target,
      activeBefore: shopReady,
      activeAfter: countShopfrontCatalogProducts(productsAfter),
      cap,
    };
  } catch (e) {
    state.sourcingLastError = e.message || String(e);
    logger.error("automation.sourcing.error", {
      cycleId,
      error: state.sourcingLastError,
      stack: e && e.stack ? e.stack : null,
    });
    try {
      await logAi(supabase, "sourcing_pass_error", { error: state.sourcingLastError, cycleId });
    } catch (_) {
      /* ignore */
    }
    return { ok: false, error: state.sourcingLastError || "sourcing_failed" };
  } finally {
    if (hasLock && supabase) await releaseLock(supabase, lockKey);
    state.sourcingRunning = false;
  }
}

async function autoFillShopToMax(supabase, opts = {}) {
  if (!supabase) return { ok: false, error: "Database not configured" };
  const cfg = await getStoreConfig(supabase);
  const cap = Math.floor(Number(cfg.maxCatalogProducts || cfg.max_products || 0));
  if (cap <= 0) return { ok: false, error: "max_products/maxCatalogProducts must be > 0" };
  const maxCycles = Math.max(1, Math.min(25, Number(opts.maxCycles) || 8));
  const perCycleLimit = Math.max(10, Math.min(20, Number(opts.perCycleLimit) || 12));
  const cooldownMs = Math.max(1000, Number(opts.cooldownMs) || Number(process.env.SOURCING_FILL_COOLDOWN_MS) || 3000);
  const progress = [];
  let insertedTotal = 0;
  const dryRun = Boolean(opts && opts.dryRun);

  if (dryRun) {
    const dry = await runSourcingPass(supabase, {
      dryRun: true,
      ignorePause: true,
      ignoreBusy: true,
      lockTtlMs: 120_000,
      targetCount: Math.max(10, Math.min(20, Number(opts.perCycleLimit) || 12)),
      perCycleLimit: Math.max(10, Math.min(20, Number(opts.perCycleLimit) || 12)),
      categoryIntent: opts.categoryIntent || null,
      chatSearchHint: opts.chatSearchHint || "",
    });
    return {
      ok: Boolean(dry && dry.ok !== false),
      dryRun: true,
      discovery: dry.discovery || { status: "no_results", reason: "filtered_out", meta: {} },
      queries: dry.queries || [],
      candidates: dry.candidates || [],
      trends: dry.trends || [],
      boostedProducts: dry.boostedProducts || [],
      learning: dry.learning || { topKeywords: [], avoidedKeywords: [], categoriesBoosted: [] },
      totalFound: Number(dry.totalFound) || 0,
      afterFiltering: Number(dry.afterFiltering) || 0,
      rejectedCount: Number(dry.rejectedCount) || 0,
      reasonsBreakdown: dry.reasonsBreakdown || {},
      wouldInsert: dry.candidates || [],
      wouldInsertCount: Number(dry.wouldInsert) || 0,
      counts: {
        totalFound: Number(dry.totalFound) || 0,
        afterFiltering: Number(dry.afterFiltering) || 0,
        rejectedCount: Number(dry.rejectedCount) || 0,
        wouldInsertCount: Number(dry.wouldInsert) || 0,
      },
      wouldRemove: [],
      netChange: Number(dry.wouldInsert) || 0,
      activeCount: countShopfrontCatalogProducts(await loadProducts(supabase)),
      cap,
      progress: [],
      status: dry && dry.status ? dry.status : "ok",
      reason: dry && dry.reason ? dry.reason : null,
    };
  }

  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const before = countShopfrontCatalogProducts(await loadProducts(supabase));
    if (before >= cap) break;
    const room = Math.max(0, cap - before);
    const target = Math.min(perCycleLimit, room);
    if (target <= 0) break;
    const out = await runSourcingPass(supabase, {
      targetCount: target,
      perCycleLimit,
      ignorePause: true,
      ignoreBusy: true,
      lockTtlMs: 120_000,
    });
    if (!out || out.ok === false) {
      progress.push({
        cycle,
        target,
        inserted: 0,
        activeBefore: before,
        activeAfter: before,
        cap,
        ok: false,
        error: out && out.reason ? out.reason : out && out.error ? out.error : "sourcing_failed",
      });
      break;
    }
    const after = countShopfrontCatalogProducts(await loadProducts(supabase));
    progress.push({
      cycle,
      target,
      inserted: Number(out && out.inserted) || 0,
      activeBefore: before,
      activeAfter: after,
      cap,
      ok: Boolean(out && out.ok !== false),
      error: out && out.ok === false ? out.error || "sourcing_failed" : null,
    });
    insertedTotal += Number(out && out.inserted) || 0;
    if (after >= cap) break;
    await new Promise((resolve) => setTimeout(resolve, cooldownMs));
  }
  const finalCount = countShopfrontCatalogProducts(await loadProducts(supabase));
  const lastErr = progress.find((p) => p && p.ok === false);
  return {
    ok: true,
    status: lastErr ? "no_results" : "ok",
    reason: lastErr ? lastErr.error || "sourcing_failed" : null,
    reachedMax: finalCount >= cap,
    activeCount: finalCount,
    cap,
    insertedTotal,
    progress,
  };
}

/**
 * Manual one-shot only (e.g. `node scripts/onetime-seed-import.js`).
 * Same pipeline as sourcing: discoverProducts → evaluateVeldenSourcing → insertEnrichedProducts.
 * Not invoked from the HTTP server or intervals.
 */
async function runOneTimeSeedImport(supabase, opts = {}) {
  if (!supabase) throw new Error("Supabase not configured");
  const storeConfig = await getStoreConfig(supabase);
  const plist = await loadProducts(supabase);
  const active = countShopfrontCatalogProducts(plist);
  const cap = Math.floor(Number(storeConfig.maxCatalogProducts) || 0);
  let desiredInsert = Math.min(48, Math.max(4, Number(opts.desiredInsert) || 24));
  if (cap > 0) desiredInsert = Math.min(desiredInsert, Math.max(0, cap - active));
  if (desiredInsert <= 0) {
    return { candidates: 0, inserted: 0, desiredInsert: 0, skippedReason: "max_catalog_products" };
  }
  const discoverPool = Math.min(64, Math.max(desiredInsert + 4, Number(opts.discoverPool) || desiredInsert + 16));
  const sourcingRunId = randomUUID();
  const insertCycleId = randomUUID();
  const discoveryLog = makeDiscoveryLogger(supabase, insertCycleId);
  const discovered = await discoverProductsDetailed(discoverPool, {
    supabase,
    storeConfig,
    runId: sourcingRunId,
    cycleId: insertCycleId,
    discoveryLog,
    ignoreAutoImportOff: true,
  });
  const raw = discovered.candidates || [];
  const insRes = await insertEnrichedProducts(
    supabase,
    raw,
    desiredInsert,
    insertCycleId,
    { exploreRatio: 0.2, exploitRatio: 0.8 },
    storeConfig,
    sourcingRunId
  );
  return {
    candidates: raw.length,
    inserted: insRes.inserted,
    desiredInsert,
    discovery: { status: discovered.status, reason: discovered.reason, meta: discovered.meta },
  };
}

module.exports = {
  runAutomationCycle,
  runSourcingPass,
  autoFillShopToMax,
  runOneTimeSeedImport,
  findNextSourcingChatCandidate,
  formatChatCandidate,
  insertApprovedSourcingRow,
  insertProvenanceProductsBatch,
  extractSourcingCategoryIntent,
  sourcingCategoryIntentLabelDa,
  getAutomationState,
  setCeoAutomationPaused,
  isCeoAutomationPaused,
  resetAutomationCircuitBreaker,
  CEO_INTERVAL_MS,
  SOURCING_INTERVAL_MS,
};
