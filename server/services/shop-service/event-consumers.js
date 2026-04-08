const { startEventWorker } = require("../events/worker");
const { EVENTS } = require("../events/contracts");
const logger = require("../../lib/logger");
const { applyLiveRankingUpdate } = require("../events/consumers/ranking-consumer");
const { ingestFeedbackEvent } = require("../events/consumers/feedback-consumer");
const { logEventToAiLog } = require("../events/consumers/logging-consumer");
const { processOrderFulfillment } = require("../fulfillment/order-fulfillment");
const { runMarketingAutomationCycle } = require("../marketing/marketing-engine");

function startShopEventConsumers(getSupabaseClient) {
  return startEventWorker({
    [EVENTS.PRODUCT_CREATED]: async (event) => {
      logger.info("events.product_created", event.payload || {});
      const supabase = getSupabaseClient ? getSupabaseClient() : null;
      await applyLiveRankingUpdate(supabase, event.payload && event.payload.productId);
      await logEventToAiLog(supabase, event);
      const productId = event.payload && event.payload.productId;
      if (supabase && productId) {
        setImmediate(() => {
          runMarketingAutomationCycle(supabase, { singleProductId: String(productId) }).catch((err) =>
            logger.warn("marketing.product_created_hook.failed", {
              productId,
              error: err && err.message ? err.message : String(err),
            })
          );
        });
      }
    },
    [EVENTS.PRODUCT_VIEWED]: async (event) => {
      logger.info("events.product_viewed", event.payload || {});
      const supabase = getSupabaseClient ? getSupabaseClient() : null;
      await applyLiveRankingUpdate(supabase, event.payload && event.payload.productId);
      await ingestFeedbackEvent(event);
      await logEventToAiLog(supabase, event);
    },
    [EVENTS.PRODUCT_CLICKED]: async (event) => {
      logger.info("events.product_clicked", event.payload || {});
      const supabase = getSupabaseClient ? getSupabaseClient() : null;
      await applyLiveRankingUpdate(supabase, event.payload && event.payload.productId);
      await ingestFeedbackEvent(event);
      await logEventToAiLog(supabase, event);
    },
    [EVENTS.ORDER_COMPLETED]: async (event) => {
      logger.info("events.order_completed", event.payload || {});
      const supabase = getSupabaseClient ? getSupabaseClient() : null;
      await applyLiveRankingUpdate(supabase, event.payload && event.payload.productId);
      await ingestFeedbackEvent(event);
      await logEventToAiLog(supabase, event);
      const orderId = event && event.payload ? event.payload.orderId : null;
      if (supabase && orderId) {
        await processOrderFulfillment(supabase, { orderId });
      }
    },
    "*": async () => {},
  });
}

module.exports = { startShopEventConsumers };
