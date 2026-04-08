const { runSourcingPass, autoFillShopToMax, CEO_INTERVAL_MS, SOURCING_INTERVAL_MS } = require("../../automation");
const logger = require("../../lib/logger");
const { getStoreConfig, updateStoreConfig } = require("../../config/store-config");
const { analyzeProductPerformance } = require("../ranking/performance-analyzer");
const { cleanupWeakProducts, boostStrongProducts } = require("../catalog/cleanup");
const { optimizeRevenueCatalog } = require("../revenue/optimizer");
const { runAiCeoCycle } = require("../ai-ceo/controller");
const { collectProductFeedback, extractLearningFeatures } = require("../learning/feedback-engine");
const { getLearningMemory, updateLearningMemory } = require("../learning/memory");
const { runMarketingAutomationCycle, refreshMarketingTokens } = require("../marketing/marketing-engine");
const { runSupplierStockSync } = require("../supplier-sync");

function startAutomationWorker(getSupabaseClient) {
  let aiCooldownUntil = 0;
  let selfImproveRunning = false;
  let fillToMaxRunning = false;
  function isAiError(err) {
    const m = String((err && err.message) || err || "").toLowerCase();
    return /gemini|ai|model|429|503|overloaded|quota/.test(m);
  }
  function shouldRunSelfImprove(cfg) {
    const now = new Date();
    const dow = now.getDay(); // 1=Mon, 4=Thu
    const last = cfg && cfg.selfImprovementLastRunAt ? new Date(cfg.selfImprovementLastRunAt).getTime() : 0;
    const since = last > 0 ? Date.now() - last : Number.POSITIVE_INFINITY;
    const oneDay = 24 * 3600000;
    const threeDays = 72 * 3600000;
    if ((dow === 1 || dow === 4) && since >= oneDay) return true;
    return since >= threeDays;
  }
  function shouldRunRevenueOptimizer(cfg) {
    const last = cfg && cfg.revenueOptimizerLastRunAt ? new Date(cfg.revenueOptimizerLastRunAt).getTime() : 0;
    const since = last > 0 ? Date.now() - last : Number.POSITIVE_INFINITY;
    return since >= 24 * 3600000;
  }
  function shouldRunAiCeoLight(cfg) {
    const last = cfg && cfg.aiCeoLightLastRunAt ? new Date(cfg.aiCeoLightLastRunAt).getTime() : 0;
    const since = last > 0 ? Date.now() - last : Number.POSITIVE_INFINITY;
    return since >= 24 * 3600000;
  }
  function shouldRunAiCeoFull(cfg) {
    const now = new Date();
    const dow = now.getDay();
    const last = cfg && cfg.aiCeoFullLastRunAt ? new Date(cfg.aiCeoFullLastRunAt).getTime() : 0;
    const since = last > 0 ? Date.now() - last : Number.POSITIVE_INFINITY;
    return (dow === 1 || dow === 4) && since >= 24 * 3600000;
  }
  function shouldRunLearningUpdate(cfg) {
    const last = cfg && cfg.learningLastRunAt ? new Date(cfg.learningLastRunAt).getTime() : 0;
    const since = last > 0 ? Date.now() - last : Number.POSITIVE_INFINITY;
    return since >= 24 * 3600000;
  }
  function shouldRunMarketing(cfg) {
    const last = cfg && cfg.marketingLastRunAt ? new Date(cfg.marketingLastRunAt).getTime() : 0;
    const since = last > 0 ? Date.now() - last : Number.POSITIVE_INFINITY;
    return since >= 60 * 60 * 1000;
  }
  function shouldRefreshMarketingTokens(cfg) {
    const last = cfg && cfg.marketingTokenRefreshLastRunAt ? new Date(cfg.marketingTokenRefreshLastRunAt).getTime() : 0;
    const since = last > 0 ? Date.now() - last : Number.POSITIVE_INFINITY;
    return since >= 6 * 3600000;
  }

  const runCatalogSelfImprove = async (dryRun = false) => {
    const supabase = getSupabaseClient();
    if (!supabase || selfImproveRunning) return null;
    selfImproveRunning = true;
    try {
      const cfg = await getStoreConfig(supabase);
      if (!dryRun && !shouldRunSelfImprove(cfg)) return null;
      logger.info("catalog.cleanup.started", { dryRun });
      const { data, error } = await supabase
        .from("products")
        .select("id,name,status,views,clicks,orders_count,created_at,updated_at,score,sourcing_status");
      if (error) throw error;
      const all = data || [];
      const perf = analyzeProductPerformance(all);
      const cleanup = await cleanupWeakProducts(supabase, all, perf.weakProducts, { dryRun, maxFraction: 0.2, cooldownHours: 48, minAgeDays: 14 });
      logger.info("catalog.cleanup.removed", { dryRun, removedCount: cleanup.removedCount });
      const boost = await boostStrongProducts(supabase, perf.strongProducts, { dryRun, boost: 8 });
      logger.info("catalog.cleanup.completed", { dryRun, weak: perf.weakProducts.length, strong: perf.strongProducts.length, boosted: boost.boostedCount });

      logger.info("catalog.refill.started", { dryRun });
      const refill = await autoFillShopToMax(supabase, {
        dryRun,
        maxCycles: 5,
        perCycleLimit: 12,
        cooldownMs: Number(process.env.SELF_IMPROVE_COOLDOWN_MS) || 3000,
      });
      logger.info("catalog.refill.completed", { dryRun, reachedMax: refill && refill.reachedMax, activeCount: refill && refill.activeCount });

      const out = {
        wouldRemove: cleanup.wouldRemove || [],
        wouldInsert: refill && refill.wouldInsert ? refill.wouldInsert : [],
        netChange: (refill && (refill.wouldInsertCount || 0)) - Number(cleanup.removedCount || 0),
      };
      if (!dryRun) {
        await updateStoreConfig(supabase, { selfImprovementLastRunAt: new Date().toISOString() });
      }
      return out;
    } finally {
      selfImproveRunning = false;
    }
  };
  const kickoff = async () => {
    const supabase = getSupabaseClient();
    if (Date.now() < aiCooldownUntil) return;
    try {
      if (supabase) {
        const cfg = await getStoreConfig(supabase);
        // Canonical orchestration path: AI CEO controller owns decision cycles.
        // Keep continuous operation by running light mode every kickoff interval.
        if (shouldRunAiCeoFull(cfg)) {
          await runAiCeoCycle({ supabase, dryRun: false, mode: "full" });
          await updateStoreConfig(supabase, { aiCeoFullLastRunAt: new Date().toISOString() });
        } else {
          await runAiCeoCycle({ supabase, dryRun: false, mode: "light" });
          await updateStoreConfig(supabase, { aiCeoLightLastRunAt: new Date().toISOString() });
        }
        if (shouldRunRevenueOptimizer(cfg)) {
          const { data, error } = await supabase
            .from("products")
            .select("id,name,status,views,clicks,orders_count,price,score,sourcing_status");
          if (!error) {
            logger.info("revenue.optimizer.started", { count: (data || []).length });
            const out = await optimizeRevenueCatalog(supabase, data || [], {
              dryRun: false,
              policy: {
                goal: cfg && cfg.strategy ? cfg.strategy.goal : "maximize_profit",
                risk: cfg && cfg.strategy ? cfg.strategy.risk : "balanced",
              },
            });
            logger.info("revenue.optimizer.completed", {
              winners: (out.winners || []).length,
              optimized: (out.optimized || []).length,
              flaggedForRemoval: (out.flaggedForRemoval || []).length,
            });
            await updateStoreConfig(supabase, { revenueOptimizerLastRunAt: new Date().toISOString() });
          }
        }
        if (shouldRunLearningUpdate(cfg)) {
          const { data, error } = await supabase
            .from("products")
            .select("id,name,category,price,views,clicks,orders_count,source_name,status,sourcing_status");
          if (!error) {
            const active = (data || []).filter(
              (p) =>
                p.status !== "removed" &&
                p.status !== "inactive" &&
                (p.sourcing_status === "approved" || p.sourcing_status == null || p.sourcing_status === "")
            );
            if (active.length >= 20) {
              const feedback = collectProductFeedback(active);
              const feats = extractLearningFeatures(feedback);
              const next = updateLearningMemory(getLearningMemory(cfg), {
                winning_keywords: feats.winningKeywords || [],
                losing_keywords: feats.losingKeywords || [],
                winning_categories: feats.topCategories || [],
                losing_categories: feats.losingCategories || [],
              });
              await updateStoreConfig(supabase, {
                learning_memory: next,
                learningLastRunAt: new Date().toISOString(),
              });
              logger.info("learning.update.completed", {
                activeCount: active.length,
                winners: (feedback.winners || []).length,
                losers: (feedback.losers || []).length,
                topKeywords: (next.winning_keywords || []).slice(0, 6),
              });
            } else {
              logger.info("learning.update.skipped", { reason: "insufficient_data", activeCount: active.length });
            }
          }
        }
        if (shouldRunMarketing(cfg)) {
          try {
            const mk = await runMarketingAutomationCycle(supabase, { dryRun: false });
            logger.info("marketing.cycle.completed", {
              posted: Number(mk && mk.posted) || 0,
              failed: Number(mk && mk.failed) || 0,
              skipped: Number(mk && mk.skipped) || 0,
              reason: mk && mk.reason ? mk.reason : null,
            });
            await updateStoreConfig(supabase, { marketingLastRunAt: new Date().toISOString() });
          } catch (e) {
            logger.warn("marketing.cycle.failed", { error: e && e.message ? e.message : String(e) });
          }
        }
        if (shouldRefreshMarketingTokens(cfg)) {
          try {
            const rf = await refreshMarketingTokens(supabase);
            logger.info("marketing.tokens.refresh.completed", {
              refreshed: Number(rf && rf.refreshed) || 0,
              failed: Number(rf && rf.failed) || 0,
            });
          } catch (e) {
            logger.warn("marketing.tokens.refresh.failed", { error: e && e.message ? e.message : String(e) });
          }
        }
      }
    } catch (e) {
      if (isAiError(e)) {
        aiCooldownUntil = Date.now() + 5 * 60 * 1000;
        logger.warn("automation.ai_temporarily_disabled", { until: new Date(aiCooldownUntil).toISOString(), reason: e.message || String(e) });
      }
      throw e;
    }
  };

  const kickoffSourcing = async () => {
    const supabase = getSupabaseClient();
    if (Date.now() < aiCooldownUntil) return;
    if (fillToMaxRunning) return;
    try {
      if (supabase) {
        const cfg = await getStoreConfig(supabase);
        const cap = Math.floor(Number(cfg.maxCatalogProducts || cfg.max_products || 0));
        if (cap > 0) {
          const { data, error } = await supabase
            .from("products")
            .select("id, status, sourcing_status");
          if (!error) {
            const active = (data || []).filter(
              (p) =>
                p.status !== "removed" &&
                p.status !== "inactive" &&
                (p.sourcing_status === "approved" || p.sourcing_status == null || p.sourcing_status === "")
            ).length;
            if (active >= cap) {
              logger.info("automation.sourcing.skip_inventory_full", { active, cap });
              return;
            }

            // Fill-mode: when catalog is not full, run sourcing loops until cap is reached.
            fillToMaxRunning = true;
            try {
              logger.info("automation.sourcing.fill_to_max.started", { active, cap });
              const out = await autoFillShopToMax(supabase, {
                dryRun: false,
                maxCycles: 12,
                perCycleLimit: 12,
                cooldownMs: Number(process.env.SOURCING_FILL_COOLDOWN_MS) || 3000,
              });
              logger.info("automation.sourcing.fill_to_max.completed", {
                reachedMax: Boolean(out && out.reachedMax),
                activeCount: Number(out && out.activeCount) || 0,
                cap,
                insertedTotal: Number(out && out.insertedTotal) || 0,
                cycles: Array.isArray(out && out.progress) ? out.progress.length : 0,
              });
            } finally {
              fillToMaxRunning = false;
            }
            return;
          }
        }
      }
      await runSourcingPass(supabase);
      await runCatalogSelfImprove(false);
    } catch (e) {
      if (isAiError(e)) {
        aiCooldownUntil = Date.now() + 5 * 60 * 1000;
        logger.warn("sourcing.ai_temporarily_disabled", { until: new Date(aiCooldownUntil).toISOString(), reason: e.message || String(e) });
      }
      throw e;
    }
  };

  const kickoffSupplierSync = async () => {
    const supabase = getSupabaseClient();
    if (!supabase) return;
    try {
      const out = await runSupplierStockSync(supabase);
      if (out && out.ok) {
        logger.info("supplier.sync.completed", {
          checked: out.checked,
          updated: out.updated,
          intervalMin: out.intervalMin,
          batchSize: out.batchSize,
        });
      } else {
        logger.warn("supplier.sync.failed", { reason: out && out.reason ? out.reason : "sync_failed" });
      }
    } catch (e) {
      logger.warn("supplier.sync.error", { error: e && e.message ? e.message : String(e) });
    }
  };

  kickoff().catch(() => {});
  setInterval(() => kickoff().catch(() => {}), CEO_INTERVAL_MS);
  // Run an early sourcing pass shortly after boot so inventory starts filling immediately.
  setTimeout(() => kickoffSourcing().catch(() => {}), 5_000);
  setInterval(() => kickoffSourcing().catch(() => {}), SOURCING_INTERVAL_MS);
  setTimeout(() => kickoffSupplierSync().catch(() => {}), 15_000);
  setInterval(
    () => kickoffSupplierSync().catch(() => {}),
    Math.max(15 * 60 * 1000, (Number(process.env.SUPPLIER_SYNC_INTERVAL_MIN) || 30) * 60 * 1000)
  );

  return {
    runCatalogSelfImprove,
  };
}

module.exports = { startAutomationWorker };
