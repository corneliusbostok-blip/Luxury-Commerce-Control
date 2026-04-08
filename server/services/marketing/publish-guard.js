/**
 * DB-backed marketing publish idempotency (see supabase/migrate_marketing_publish_guard.sql).
 */

const logger = require("../../lib/logger");

function uncertaintySec() {
  return Math.max(60, Math.min(86400, Number(process.env.MARKETING_UNCERTAINTY_SEC) || 1800));
}

function parseSlotResult(data) {
  if (!data || typeof data !== "object") {
    return { allowed: false, reason: "invalid_rpc_payload" };
  }
  return {
    allowed: data.allowed === true,
    reason: data.reason != null ? String(data.reason) : "",
  };
}

/**
 * @returns {Promise<{ allowed: boolean, reason: string }>}
 */
async function acquirePublishSlot(supabase, refKey, platform, leaseSec = 180) {
  if (!supabase || !refKey || !platform) {
    return { allowed: false, reason: "no_db" };
  }
  const { data, error } = await supabase.rpc("marketing_acquire_publish_slot", {
    p_ref_key: String(refKey),
    p_platform: String(platform),
    p_lease_sec: Math.max(30, Math.min(900, Number(leaseSec) || 180)),
  });
  if (error) {
    logger.error("marketing.publish_guard.acquire_rpc_failed", {
      message: error.message,
      code: error.code,
    });
    throw new PublishGuardRpcError(`marketing_acquire_publish_slot: ${error.message || error.code || "rpc_error"}`);
  }
  return parseSlotResult(data);
}

function parseBeginResult(data) {
  if (!data || typeof data !== "object") {
    return { ok: false, reason: "invalid_rpc_payload" };
  }
  return {
    ok: data.ok === true,
    reason: data.reason != null ? String(data.reason) : "",
  };
}

/**
 * Persist { status: "publishing", started_at: now } BEFORE calling TikTok/Meta.
 * @returns {Promise<{ ok: boolean, reason: string }>}
 */
async function beginOutboundPublishOnce(supabase, refKey, platform, uncertaintySecArg) {
  if (!supabase || !refKey || !platform) {
    return { ok: false, reason: "no_db" };
  }
  const u = Math.max(60, Math.min(86400, Number(uncertaintySecArg) || uncertaintySec()));
  const { data, error } = await supabase.rpc("marketing_begin_outbound_publish", {
    p_ref_key: String(refKey),
    p_platform: String(platform),
    p_uncertainty_sec: u,
  });
  if (error) {
    logger.error("marketing.publish_guard.begin_rpc_failed", {
      message: error.message,
      code: error.code,
    });
    throw new PublishGuardRpcError(`marketing_begin_outbound_publish: ${error.message || error.code || "rpc_error"}`);
  }
  return parseBeginResult(data);
}

async function beginOutboundPublishWithRetry(supabase, refKey, platform, attempts = 14) {
  let lastReason = "";
  for (let i = 0; i < attempts; i += 1) {
    const out = await beginOutboundPublishOnce(supabase, refKey, platform);
    if (out.ok) return out;
    lastReason = out.reason || "";
    if (
      lastReason === "uncertain_publishing" ||
      lastReason === "already_posted" ||
      lastReason === "invalid_ref" ||
      lastReason === "invalid_platform"
    ) {
      return out;
    }
    logger.warn("marketing.publish_guard.begin_retry", {
      attempt: i + 1,
      refKey: String(refKey),
      platform: String(platform),
      reason: lastReason,
    });
    await new Promise((r) => setTimeout(r, 180 * 2 ** i + Math.floor(Math.random() * 120)));
  }
  return { ok: false, reason: lastReason || "begin_exhausted" };
}

class PublishGuardRpcError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublishGuardRpcError";
    this.code = "PUBLISH_GUARD_RPC_REQUIRED";
  }
}

/**
 * @returns {Promise<boolean>}
 */
async function isPublishDone(supabase, refKey, platform) {
  if (!supabase || !refKey || !platform) return false;
  const { data, error } = await supabase.rpc("marketing_publish_is_done", {
    p_ref_key: String(refKey),
    p_platform: String(platform),
  });
  if (error) {
    logger.warn("marketing.publish_guard.is_done_rpc_failed", { message: error.message });
    throw new PublishGuardRpcError(`marketing_publish_is_done: ${error.message || "rpc_error"}`);
  }
  return data === true;
}

async function completePublishOnce(supabase, refKey, platform, success, publisherRef, errMsg) {
  const { error } = await supabase.rpc("marketing_complete_publish", {
    p_ref_key: String(refKey),
    p_platform: String(platform),
    p_success: Boolean(success),
    p_publisher_ref: publisherRef != null ? String(publisherRef) : "",
    p_error: errMsg != null ? String(errMsg) : "",
  });
  if (error) {
    throw new Error(error.message || "marketing_complete_publish failed");
  }
}

/**
 * Durable commit after provider success — retry until DB accepts (critical for idempotency).
 */
async function completePublishDurableWithRetry(
  supabase,
  refKey,
  platform,
  success,
  publisherRef,
  errMsg,
  attempts = 12
) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await completePublishOnce(supabase, refKey, platform, success, publisherRef, errMsg);
      return;
    } catch (e) {
      lastErr = e;
      logger.warn("marketing.publish_guard.complete_retry", {
        attempt: i + 1,
        refKey: String(refKey),
        platform: String(platform),
        error: e && e.message ? e.message : String(e),
      });
      await new Promise((r) => setTimeout(r, 200 * 2 ** i + Math.floor(Math.random() * 150)));
    }
  }
  logger.error("marketing.publish_guard.complete_exhausted", {
    refKey: String(refKey),
    platform: String(platform),
    success: Boolean(success),
    error: lastErr && lastErr.message ? lastErr.message : String(lastErr),
  });
  throw lastErr || new Error("marketing_complete_publish_exhausted");
}

module.exports = {
  acquirePublishSlot,
  beginOutboundPublishOnce,
  beginOutboundPublishWithRetry,
  uncertaintySec,
  isPublishDone,
  completePublishOnce,
  completePublishDurableWithRetry,
  PublishGuardRpcError,
};
