const {
  CHECKOUT_STATUS,
  buildPendingRecoveryPayload,
  isClientCancellableCheckoutStatus,
  markCheckoutTerminal,
  paymentCheckoutRef,
  paymentIntentId,
  retrievePaymentIntent,
  syncCheckoutFromPaymentIntent,
  terminalRecoveryResult,
  throwAndLogHttpsError,
} = require("./utils/paymentFlow.util");

async function recoverBookingPaymentSession(request) {
  const auth = request.auth;
  const { checkoutId } = request.data || {};
  if (!auth) throwAndLogHttpsError("permission-denied", "User must be authenticated");
  if (!checkoutId) return { success: true, hasPendingCheckout: false };

  const checkoutRef = paymentCheckoutRef(checkoutId);
  const checkoutSnap = await checkoutRef.get();
  if (!checkoutSnap.exists) return { success: true, hasPendingCheckout: false };
  const checkout = { id: checkoutSnap.id, ...checkoutSnap.data() };
  if (checkout.renterId !== auth.uid) throwAndLogHttpsError("permission-denied", "Checkout does not belong to this user");
  if (!isClientCancellableCheckoutStatus(checkout.status)) return terminalRecoveryResult(checkout);
  if (!checkout.paymentIntentId) {
    await markCheckoutTerminal({ checkout, reason: "Payment checkout was incomplete", status: CHECKOUT_STATUS.failed });
    return { success: true, hasPendingCheckout: false, status: CHECKOUT_STATUS.failed, paymentStatus: CHECKOUT_STATUS.failed };
  }
  if (Number(checkout.checkoutLockExpiresAtMs || 0) <= Date.now()) {
    await markCheckoutTerminal({ checkout, reason: "Pending payment expired", status: CHECKOUT_STATUS.expired });
    return { success: true, hasPendingCheckout: false, status: CHECKOUT_STATUS.expired, paymentStatus: CHECKOUT_STATUS.expired };
  }

  const paymentIntent = await retrievePaymentIntent(checkout.paymentIntentId);
  const syncResult = await syncCheckoutFromPaymentIntent({ checkoutId, paymentIntent, source: "recovery" });
  if ([CHECKOUT_STATUS.booked, CHECKOUT_STATUS.paid, CHECKOUT_STATUS.failed, CHECKOUT_STATUS.expired].includes(syncResult.status)) {
    return { success: true, hasPendingCheckout: false, ...syncResult };
  }
  return buildPendingRecoveryPayload({ checkout, syncResult });
}

module.exports = { recoverBookingPaymentSession };
