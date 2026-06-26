const {
  CHECKOUT_STATUS,
  FieldValue,
  admin,
  attachPaymentMethod,
  listCustomerPaymentMethods,
  normalizePayMongoError,
  paymentCheckoutRef,
  paymentIntentAttributes,
  paymentIntentId,
  syncCheckoutFromPaymentIntent,
  throwAndLogHttpsError,
  updatePaymentMethodCvc,
  userPaymentProfileRef,
} = require("./utils/paymentFlow.util");

async function attachSavedPaymentMethodToSession(request) {
  const auth = request.auth;
  const { checkoutId, customerPaymentMethodId, cvc } = request.data || {};
  if (!auth) throwAndLogHttpsError("permission-denied", "User must be authenticated");
  if (!checkoutId || !customerPaymentMethodId || !/^\d{3,4}$/.test(String(cvc || ""))) {
    throwAndLogHttpsError("invalid-argument", "Missing checkout, saved card, or CVC");
  }

  const db = admin.firestore();
  const [profileSnap, checkoutSnap] = await Promise.all([userPaymentProfileRef(auth.uid).get(), paymentCheckoutRef(checkoutId).get()]);
  const customerId = profileSnap.data()?.paymongoCustomerId;
  if (!customerId) throwAndLogHttpsError("failed-precondition", "No PayMongo customer is registered");
  if (!checkoutSnap.exists) throwAndLogHttpsError("not-found", "Payment checkout not found");
  const checkout = checkoutSnap.data();
  if (checkout.renterId !== auth.uid) throwAndLogHttpsError("permission-denied", "Checkout does not belong to this user");

  try {
    const methods = await listCustomerPaymentMethods(customerId);
    const selected = (methods?.data || []).find((method) => method.id === customerPaymentMethodId);
    const paymentMethodId = selected?.attributes?.payment_method_id;
    if (!paymentMethodId || selected?.attributes?.payment_method_type !== "card") {
      throwAndLogHttpsError("not-found", "Saved card not found");
    }
    await updatePaymentMethodCvc({ paymentMethodId, cvc: String(cvc) });
    const attached = await attachPaymentMethod({
      paymentIntentId: checkout.paymentIntentId,
      paymentMethodId,
      clientKey: checkout.paymentIntentClientKey,
      returnUrl: checkout.returnUrl,
    });
    await db.collection("paymentCheckouts").doc(checkoutId).set(
      {
        status: CHECKOUT_STATUS.processing,
        selectedCustomerPaymentMethodId: customerPaymentMethodId,
        selectedPaymongoPaymentMethodId: paymentMethodId,
        paymentStatus: paymentIntentAttributes(attached).status || null,
        updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      },
      { merge: true },
    );
    return syncCheckoutFromPaymentIntent({ checkoutId, paymentIntent: attached, source: "saved-card-attach" });
  } catch (error) {
    if (error?.code) throw error;
    const normalized = normalizePayMongoError(error);
    throwAndLogHttpsError("internal", `Unable to charge saved card: ${normalized.message}`, normalized);
  }
}

module.exports = { attachSavedPaymentMethodToSession };
