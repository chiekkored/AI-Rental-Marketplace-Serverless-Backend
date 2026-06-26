const {
  CHECKOUT_STATUS,
  isClientCancellableCheckoutStatus,
  markCheckoutTerminal,
  normalizeClientCancelReason,
  paymentCheckoutRef,
  throwAndLogHttpsError,
} = require("./utils/paymentFlow.util");

async function cancelBookingPaymentSession(request) {
  const auth = request.auth;
  const { checkoutId, reason } = request.data || {};
  if (!auth) throwAndLogHttpsError("permission-denied", "User must be authenticated");
  if (!checkoutId) throwAndLogHttpsError("invalid-argument", "Missing checkoutId");
  const checkoutSnap = await paymentCheckoutRef(checkoutId).get();
  if (!checkoutSnap.exists) throwAndLogHttpsError("not-found", "Payment checkout not found");
  const checkout = { id: checkoutSnap.id, ...checkoutSnap.data() };
  if (checkout.renterId !== auth.uid) throwAndLogHttpsError("permission-denied", "Checkout does not belong to this user");
  if (!isClientCancellableCheckoutStatus(checkout.status)) {
    return { success: true, status: checkout.status || null, cancelled: false };
  }
  await markCheckoutTerminal({
    checkout,
    reason: normalizeClientCancelReason(reason),
    status: CHECKOUT_STATUS.failed,
    cancelledBy: "client",
  });
  return { success: true, status: CHECKOUT_STATUS.failed, cancelled: true };
}

module.exports = { cancelBookingPaymentSession };
