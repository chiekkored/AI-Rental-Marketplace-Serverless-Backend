const assert = require("node:assert/strict");
const test = require("node:test");

const {
  reconcilePendingPaymentCheckouts,
  reconcilePendingPaymentCheckoutsRun,
  _test: { ACTIVE_CHECKOUT_STATUSES },
} = require("../scheduled/reconcilePendingPaymentCheckouts");

test("reconcile pending payment checkouts exports scheduled job and active statuses", () => {
  assert.equal(typeof reconcilePendingPaymentCheckouts, "function");
  assert.equal(typeof reconcilePendingPaymentCheckoutsRun, "function");
  assert.deepEqual(ACTIVE_CHECKOUT_STATUSES, ["initialized", "processing", "subscription_pending"]);
});

test("reconcile pending payment checkouts exits without scanning when disabled", async () => {
  const result = await reconcilePendingPaymentCheckoutsRun({
    paymentReconciliationEnabled: false,
  });

  assert.deepEqual(result, {
    success: true,
    summary: { disabled: true, scanned: 0 },
    results: [],
  });
});
