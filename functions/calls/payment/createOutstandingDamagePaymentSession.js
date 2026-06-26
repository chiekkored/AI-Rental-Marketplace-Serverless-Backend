const {
  CHECKOUT_STATUS,
  CHECKOUT_TYPE,
  FieldValue,
  admin,
  bookingCurrency,
  buildOutstandingDamagePriceBreakdown,
  createPaymentIntent,
  getBookingActors,
  getPayMongoCheckoutReturnUrl,
  getPayMongoPublicKey,
  getPricingPolicyConfig,
  normalizePayMongoError,
  normalizeSelectedPaymentMethod,
  normalizeSelectedPaymentMethodDetails,
  paymentIntentId,
  throwAndLogHttpsError,
  toPayMongoAmount,
} = require("./utils/paymentFlow.util");
const {
  allowedPayMongoMethodsForMode,
  assertPaymentMethodAvailable,
  getPaymentMethodsConfig,
} = require("../../utils/paymentMethodsConfig.util");

async function createOutstandingDamagePaymentSession(request) {
  const auth = request.auth;
  const {
    bookingId,
    damagePaymentRequestId,
    selectedPaymentMethod,
    selectedPaymentMethodDetails,
  } = request.data || {};
  if (!auth) throwAndLogHttpsError("permission-denied", "User must be authenticated");
  if (!bookingId || !damagePaymentRequestId) throwAndLogHttpsError("invalid-argument", "Missing damage payment request details");
  const paymentMethod = normalizeSelectedPaymentMethod(selectedPaymentMethod);
  const paymentMethodDetails = normalizeSelectedPaymentMethodDetails(selectedPaymentMethodDetails);
  const db = admin.firestore();
  const bookingRef = db.collection("bookings").doc(bookingId);
  const requestRef = db.collection("damageBalancePaymentRequests").doc(damagePaymentRequestId);
  const [bookingSnap, requestSnap] = await Promise.all([bookingRef.get(), requestRef.get()]);
  if (!bookingSnap.exists) throwAndLogHttpsError("not-found", "Booking not found");
  if (!requestSnap.exists) throwAndLogHttpsError("not-found", "Damage payment request not found");
  const booking = bookingSnap.data();
  const paymentRequest = requestSnap.data();
  const { renterId, ownerId } = getBookingActors(booking);
  if (auth.uid !== renterId) throwAndLogHttpsError("permission-denied", "Only the renter can pay this damage balance");
  if (paymentRequest.bookingId !== bookingId || paymentRequest.renterId !== renterId || paymentRequest.status !== "pending") {
    throwAndLogHttpsError("failed-precondition", "Damage payment request is not payable");
  }
  const renterSnap = await db.collection("users").doc(renterId).get();
  const renter = renterSnap.data() || {};

  const amount = Number(paymentRequest.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) throwAndLogHttpsError("failed-precondition", "Damage payment request amount is invalid");
  const [policy, paymentMethodsConfig] = await Promise.all([getPricingPolicyConfig(), getPaymentMethodsConfig()]);
  assertPaymentMethodAvailable({
    config: paymentMethodsConfig,
    mode: "upfront",
    paymentMethod,
    paymentMethodDetails,
  });
  const priceBreakdown = buildOutstandingDamagePriceBreakdown({
    amount,
    policy,
    selectedPaymentMethod: paymentMethod,
    selectedPaymentMethodDetails: paymentMethodDetails,
    payerCountryShortName: renter?.location?.countryShortName,
    currency: paymentRequest.currency || bookingCurrency(booking),
  });
  const renterProcessingFee = priceBreakdown.renterProcessingFee;
  const paymentAmount = priceBreakdown.paymentAmount;
  const checkoutRef = db.collection("paymentCheckouts").doc();
  const currency = paymentRequest.currency || bookingCurrency(booking);
  const returnUrl = getPayMongoCheckoutReturnUrl(checkoutRef.id);
  const checkoutBase = {
    id: checkoutRef.id,
    checkoutId: checkoutRef.id,
    checkoutType: CHECKOUT_TYPE.outstandingDamage,
    bookingId,
    chatId: paymentRequest.chatId || booking?.disputeFlow?.renterSupportChatId || booking.chatId,
    damagePaymentRequestId,
    renterId,
    ownerId,
    amount,
    currency,
    selectedPaymentMethod: paymentMethod,
    selectedPaymentMethodDetails: paymentMethodDetails,
    shouldSaveCard: false,
    cardVaultingRequired: false,
    cardVaultingRequested: false,
    paymongoCustomerId: null,
    status: CHECKOUT_STATUS.initialized,
    paymentAmount,
    paymongoPaymentAmount: toPayMongoAmount(paymentAmount),
    priceBreakdown,
    returnUrl,
    createdAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
  };
  await checkoutRef.set(checkoutBase);

  let paymentIntent;
  try {
    paymentIntent = await createPaymentIntent({
      amount: paymentAmount,
      currency,
      description: `Lend damage balance for ${booking?.asset?.title || bookingId}`,
      paymentMethods: [paymentMethod],
      metadata: {
        checkout_id: checkoutRef.id,
        checkout_type: CHECKOUT_TYPE.outstandingDamage,
        booking_id: bookingId,
        damage_payment_request_id: damagePaymentRequestId,
        renter_id: renterId,
        owner_id: ownerId,
      },
    });
  } catch (error) {
    await checkoutRef.set({ status: CHECKOUT_STATUS.failed, updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date() }, { merge: true });
    const normalized = normalizePayMongoError(error);
    throwAndLogHttpsError("internal", `Unable to create PayMongo Payment Intent: ${normalized.message}`, normalized);
  }
  const attrs = paymentIntent?.data?.attributes || {};
  await checkoutRef.set(
    {
      paymentIntentId: paymentIntent?.data?.id || null,
      paymentIntentClientKey: attrs.client_key || null,
      paymentStatus: attrs.status || null,
      updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    },
    { merge: true },
  );
  return {
    success: true,
    checkoutId: checkoutRef.id,
    paymentIntentId: paymentIntent?.data?.id || null,
    clientKey: attrs.client_key || null,
    publicKey: getPayMongoPublicKey(),
    returnUrl,
    allowedPaymentMethods: allowedPayMongoMethodsForMode(paymentMethodsConfig, "upfront"),
    amount,
    paymentAmount,
    renterProcessingFee,
    paymongoPaymentAmount: toPayMongoAmount(paymentAmount),
    priceBreakdown: checkoutBase.priceBreakdown,
    pricingBreakdown: checkoutBase.priceBreakdown,
  };
}

module.exports = { createOutstandingDamagePaymentSession };
