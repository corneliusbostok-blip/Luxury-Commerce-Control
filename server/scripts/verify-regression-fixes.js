#!/usr/bin/env node
/**
 * Regression checks for checkout pay-time inventory, event bus (Redis path), run mode.
 * Run: node server/scripts/verify-regression-fixes.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  validateLineAgainstProduct,
  validateProductRowForCheckout,
} = require("../lib/checkout-inventory");

function testCheckoutInventory() {
  const okProduct = {
    id: "a",
    status: "active",
    available: true,
    sourcing_status: "approved",
    supplier_variants: [{ size: "M", color: "Navy", available: true }],
  };
  assert.strictEqual(validateProductRowForCheckout(okProduct).ok, true);
  assert.strictEqual(
    validateLineAgainstProduct(okProduct, { product_id: "a", size: "M", color: "Navy" }).ok,
    true
  );

  const oosVariant = {
    ...okProduct,
    supplier_variants: [{ size: "M", color: "Navy", available: false }],
  };
  assert.strictEqual(
    validateLineAgainstProduct(oosVariant, { product_id: "a", size: "M", color: "Navy" }).reason,
    "out_of_stock_at_payment"
  );

  const inactive = { ...okProduct, status: "inactive" };
  assert.strictEqual(validateProductRowForCheckout(inactive).ok, false);

  const unavailable = { ...okProduct, available: false };
  assert.strictEqual(validateProductRowForCheckout(unavailable).ok, false);

  console.log("OK checkout-inventory guards");
}

function testRunMode() {
  const { detectServerlessRuntime } = require("../lib/run-mode");
  const keys = ["VELDEN_RUN_MODE", "NETLIFY", "AWS_LAMBDA_FUNCTION_NAME", "VERCEL"];
  const snapshot = {};
  for (const k of keys) snapshot[k] = process.env[k];
  try {
    for (const k of keys) delete process.env[k];
    assert.strictEqual(detectServerlessRuntime(), false);
    process.env.NETLIFY = "true";
    assert.strictEqual(detectServerlessRuntime(), true);
    console.log("OK run-mode detection");
  } finally {
    for (const k of keys) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  }
}

function testBusRedisThrowsOnFailure() {
  const busPath = path.join(__dirname, "..", "services", "events", "bus.js");
  const src = fs.readFileSync(busPath, "utf8");
  assert.ok(src.includes("throw err"), "bus.js must throw on queue.add failure");
  assert.ok(!/catch \(e\) \{[^}]*localBus\.emit/m.test(src), "bus.js catch must not emit to localBus");
  console.log("OK events/bus Redis failure policy (static source check)");
}

function main() {
  console.log("=== verify-regression-fixes ===\n");
  testCheckoutInventory();
  testRunMode();
  testBusRedisThrowsOnFailure();
  console.log("\nAll checks passed.");
}

main();
