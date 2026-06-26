const { onSchedule } = require("firebase-functions/v2/scheduler");
const {
  CHECKOUT_STATUS,
  admin,
  isClientCancellableCheckoutStatus,
  markCheckoutTerminal,
  paymentCheckoutRef,
  retrievePaymentIntent,
  syncCheckoutFromPaymentIntent,
} = require("../calls/payment/utils/paymentFlow.util");
const { FUNCTIONS_REGION } = require("../utils/functionsRegion.util");
const { getPaymentReconciliationEnabledConfig } = require("../utils/remoteConfig.util");

const ACTIVE_CHECKOUT_STATUSES = [
  CHECKOUT_STATUS.initialized,
  CHECKOUT_STATUS.processing,
  CHECKOUT_STATUS.subscriptionPending,
];
const DEFAULT_BATCH_LIMIT = 50;

async function reconcileCheckout(checkout, { nowMs = Date.now() } = {}) {
  if (!checkout?.id || !isClientCancellableCheckoutStatus(checkout.status)) {
    return { checkoutId: checkout?.id || null, action: "skipped_terminal" };
  }

  const expired = Number(checkout.checkoutLockExpiresAtMs || 0) <= nowMs;
  if (!checkout.paymentIntentId) {
    if (!expired) {
      return { checkoutId: checkout.id, action: "skipped_incomplete_active" };
    }
    await markCheckoutTerminal({
      checkout,
      reason: "Payment checkout was incomplete",
      status: CHECKOUT_STATUS.expired,
    });
    return { checkoutId: checkout.id, action: "expired_incomplete" };
  }

  const paymentIntent = await retrievePaymentIntent(checkout.paymentIntentId);
  const syncResult = await syncCheckoutFromPaymentIntent({
    checkoutId: checkout.id,
    paymentIntent,
    source: "scheduled-reconcile",
  });

  if (
    [
      CHECKOUT_STATUS.booked,
      CHECKOUT_STATUS.paid,
      CHECKOUT_STATUS.failed,
      CHECKOUT_STATUS.expired,
      CHECKOUT_STATUS.cancelled,
    ].includes(syncResult.status)
  ) {
    return { checkoutId: checkout.id, action: syncResult.status };
  }

  if (expired) {
    const latestSnap = await paymentCheckoutRef(checkout.id).get();
    const latestCheckout = latestSnap.exists ? { id: latestSnap.id, ...latestSnap.data() } : checkout;
    if (isClientCancellableCheckoutStatus(latestCheckout.status)) {
      await markCheckoutTerminal({
        checkout: latestCheckout,
        reason: "Pending payment expired",
        status: CHECKOUT_STATUS.expired,
      });
      return { checkoutId: checkout.id, action: "expired_after_sync" };
    }
  }

  return { checkoutId: checkout.id, action: "still_pending", paymentStatus: syncResult.paymentStatus || null };
}

async function reconcilePendingPaymentCheckoutsRun({
  batchLimit = DEFAULT_BATCH_LIMIT,
  paymentReconciliationEnabled,
} = {}) {
  const enabled =
    typeof paymentReconciliationEnabled === "boolean"
      ? paymentReconciliationEnabled
      : await getPaymentReconciliationEnabledConfig();
  if (!enabled) {
    const summary = { disabled: true, scanned: 0 };
    console.log("[reconcilePendingPaymentCheckouts] disabled", summary);
    return { success: true, summary, results: [] };
  }

  const snap = await admin
    .firestore()
    .collection("paymentCheckouts")
    .where("status", "in", ACTIVE_CHECKOUT_STATUSES)
    .limit(batchLimit)
    .get();

  const results = [];
  for (const doc of snap.docs) {
    const checkout = { id: doc.id, ...doc.data() };
    try {
      results.push(await reconcileCheckout(checkout));
    } catch (error) {
      console.error(`[reconcilePendingPaymentCheckouts] Checkout ${doc.id} failed: ${error.message}`);
      results.push({ checkoutId: doc.id, action: "error", error: error.message });
    }
  }

  const summary = results.reduce(
    (acc, result) => {
      acc[result.action] = (acc[result.action] || 0) + 1;
      return acc;
    },
    { scanned: snap.size },
  );
  console.log("[reconcilePendingPaymentCheckouts] complete", summary);
  return { success: true, summary, results };
}

const reconcilePendingPaymentCheckouts = onSchedule(
  { schedule: "every 15 minutes", region: FUNCTIONS_REGION },
  () => reconcilePendingPaymentCheckoutsRun(),
);

module.exports = {
  reconcilePendingPaymentCheckouts,
  reconcilePendingPaymentCheckoutsRun,
  _test: {
    ACTIVE_CHECKOUT_STATUSES,
    reconcileCheckout,
  },
};
