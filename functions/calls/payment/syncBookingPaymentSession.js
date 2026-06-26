const {
  syncPaymentSession,
} = require("./utils/paymentFlow.util");

async function syncBookingPaymentSession(request) {
  const { checkoutId } = request.data || {};
  return syncPaymentSession({ auth: request.auth, checkoutId, source: "client-sync" });
}

module.exports = { syncBookingPaymentSession };
