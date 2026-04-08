#!/usr/bin/env node
/**
 * Production readiness checks for locks + marketing idempotency RPCs.
 * Run: node server/scripts/verify-system-guarantees.js
 *
 * Scenarios covered (manual / mental model):
 * - Double trigger (PRODUCT_CREATED + worker): automation lock + publish guard lease → one publisher;
 *   after success, marketing_publish_guard.posted_at blocks the second run even if store_config log is empty.
 * - publishing state: marketing_begin_outbound_publish BEFORE provider; uncertain_publishing blocks repost.
 * - Network retry: TikTok provider retries only safe classes; lease eventually clears on failure path via
 *   marketing_complete_publish(success=false).
 * - Log write failure: durable row is written before appendPostLogWithRetry; second trigger sees isPublishDone.
 */

require("../load-env");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function main() {
  console.log("=== Luxury Commerce Control — system guarantees ===\n");
  console.log("1. Atomic lock: acquire_automation_lock RPC must exist (no marketing without it unless ALLOW_NON_ATOMIC_LOCKS=1).");
  console.log("2. Idempotency: marketing_publish_guard + acquire / begin_outbound / complete.");
  console.log("3. CEO risk: riskAdaptation in store_config + enforceRiskCapsOnPlan(adaptMultiplier).\n");

  if (!url || !key) {
    console.log("Skip live RPC check: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.\n");
    process.exit(0);
  }

  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(url, key);

  const lockKey = `__verify_atomic_${Date.now()}`;
  const { data: got, error: e1 } = await sb.rpc("acquire_automation_lock", {
    p_key: lockKey,
    p_ttl_ms: 8000,
  });
  if (e1) {
    console.error("FAIL acquire_automation_lock:", e1.message || e1);
    process.exit(1);
  }
  if (got !== true) {
    console.error("FAIL acquire_automation_lock: expected true on cold key, got", got);
    process.exit(1);
  }
  console.log("OK acquire_automation_lock");

  await sb.from("automation_locks").delete().eq("key", lockKey);

  const ref = `__verify_pub_${Date.now()}`;
  const { data: slot, error: e2 } = await sb.rpc("marketing_acquire_publish_slot", {
    p_ref_key: ref,
    p_platform: "facebook",
    p_lease_sec: 30,
  });
  if (e2) {
    console.error("FAIL marketing_acquire_publish_slot:", e2.message || e2);
    console.error("Apply supabase/migrate_marketing_publish_guard.sql (+ migrate_marketing_publish_guard_state.sql).");
    process.exit(1);
  }
  if (!slot || slot.allowed !== true) {
    console.error("FAIL marketing_acquire_publish_slot: expected allowed true, got", slot);
    process.exit(1);
  }
  console.log("OK marketing_acquire_publish_slot (claim)");

  const { data: beg, error: eb } = await sb.rpc("marketing_begin_outbound_publish", {
    p_ref_key: ref,
    p_platform: "facebook",
    p_uncertainty_sec: 1800,
  });
  if (eb) {
    console.error("FAIL marketing_begin_outbound_publish:", eb.message || eb);
    console.error("Apply supabase/migrate_marketing_publish_guard_state.sql");
    process.exit(1);
  }
  if (!beg || beg.ok !== true) {
    console.error("FAIL marketing_begin_outbound_publish: expected ok true, got", beg);
    process.exit(1);
  }
  console.log("OK marketing_begin_outbound_publish (pre-provider state)");

  const { data: beg2 } = await sb.rpc("marketing_begin_outbound_publish", {
    p_ref_key: ref,
    p_platform: "facebook",
    p_uncertainty_sec: 1800,
  });
  if (!beg2 || beg2.ok !== false || beg2.reason !== "uncertain_publishing") {
    console.error("FAIL second begin should be uncertain_publishing, got", beg2);
    process.exit(1);
  }
  console.log("OK uncertain_publishing blocks duplicate begin");

  const { data: slotDup } = await sb.rpc("marketing_acquire_publish_slot", {
    p_ref_key: ref,
    p_platform: "facebook",
    p_lease_sec: 30,
  });
  if (!slotDup || slotDup.allowed !== false || slotDup.reason !== "uncertain_publishing") {
    console.error("FAIL acquire during publishing should be uncertain_publishing, got", slotDup);
    process.exit(1);
  }
  console.log("OK acquire rejects concurrent worker while publishing (uncertain_publishing)");

  const { error: e3 } = await sb.rpc("marketing_complete_publish", {
    p_ref_key: ref,
    p_platform: "facebook",
    p_success: true,
    p_publisher_ref: "verify-script",
    p_error: "",
  });
  if (e3) {
    console.error("FAIL marketing_complete_publish:", e3.message || e3);
    process.exit(1);
  }
  console.log("OK marketing_complete_publish (success)");

  const { data: done, error: e4 } = await sb.rpc("marketing_publish_is_done", {
    p_ref_key: ref,
    p_platform: "facebook",
  });
  if (e4 || done !== true) {
    console.error("FAIL marketing_publish_is_done:", e4, done);
    process.exit(1);
  }
  console.log("OK marketing_publish_is_done");

  const { data: slot3 } = await sb.rpc("marketing_acquire_publish_slot", {
    p_ref_key: ref,
    p_platform: "facebook",
    p_lease_sec: 30,
  });
  if (!slot3 || slot3.allowed !== false || slot3.reason !== "already_posted") {
    console.error("FAIL second claim should be already_posted, got", slot3);
    process.exit(1);
  }
  console.log("OK idempotency: claim rejected after posted (already_posted)\n");

  await sb.from("marketing_publish_guard").delete().eq("ref_key", ref);

  console.log("All live checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
