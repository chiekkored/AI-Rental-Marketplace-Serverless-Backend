const {
  ACTIVE_BOOKING_STATUSES,
  CHECKOUT_STATUS,
  CHECKOUT_TYPE,
  FieldValue,
  admin,
  buildBookingPriceBreakdown,
  calculateRentalSubtotal,
  cancelCheckoutSubscriptions,
  createPaymentIntent,
  createSubscription,
  createSubscriptionPlan,
  getPayMongoCheckoutReturnUrl,
  getPayMongoPublicKey,
  getOrCreatePayMongoCustomerId,
  getPricingPolicyConfig,
  listingCurrencyFromAsset,
  normalizeBookingRange,
  normalizePayMongoError,
  normalizeSecurityDeposit,
  normalizeSelectedPaymentMethod,
  normalizeSelectedPaymentMethodDetails,
  paymentIntentId,
  releaseCheckoutDateLocks,
  reserveCheckoutDateLocks,
  resolveCheckoutLockExpiryMs,
  throwAndLogHttpsError,
  userPaymentProfileRef,
  writeSubscriptionMappings,
} = require("./utils/paymentFlow.util");
const { assertAssetMinimumNights } = require("../../utils/booking.util");
const {
  allowedPayMongoMethodsForMode,
  assertPaymentMethodAvailable,
  getPaymentMethodsConfig,
} = require("../../utils/paymentMethodsConfig.util");
const { assertUsersCanInteract } = require("../../utils/userBlock.util");
const { assertUserCanReceiveNewBooking } = require("../account/deactivation");
const {
  assertRecurringPaymentMethodSupported,
  buildRecurringBillingPlan,
  buildRentalBillingChunks,
  subtotalFromBillingChunks,
} = require("./recurringBilling");

function compactMetadata(metadata) {
  return Object.entries(metadata || {}).reduce((acc, [key, value]) => {
    if (value == null) return acc;
    acc[key] = String(value);
    return acc;
  }, {});
}

function subscriptionScheduleSetupIntent(schedule) {
  const setupIntent = schedule?.setupIntent;
  if (!setupIntent?.nextActionUrl) return null;
  return {
    type: "redirect",
    redirect: { url: setupIntent.nextActionUrl },
    url: setupIntent.nextActionUrl,
    source: "paymongo_subscription_setup",
    setupIntentId: setupIntent.id || null,
    subscriptionScheduleId: schedule.id || null,
  };
}

function subscriptionScheduleFromProvider(schedule, plan, subscription) {
  const attrs = subscription?.data?.attributes || {};
  const setupIntent = attrs.setup_intent || null;
  const providerStatus = attrs.status || null;
  const status =
    providerStatus === "active"
      ? "active"
      : providerStatus === "past_due" || providerStatus === "unpaid"
        ? "payment_issue"
        : providerStatus === "cancelled" || providerStatus === "incomplete_cancelled"
          ? "cancelled"
          : "pending_setup";
  return {
    ...schedule,
    status,
    providerStatus,
    paymongoPlanId: plan?.data?.id || schedule.paymongoPlanId || null,
    paymongoSubscriptionId: subscription?.data?.id || schedule.paymongoSubscriptionId || null,
    defaultCustomerPaymentMethodId: attrs.default_customer_payment_method_id || null,
    setupIntent: setupIntent
      ? {
          id: setupIntent.id || null,
          status: setupIntent.status || null,
          nextActionUrl: setupIntent.next_action_url || null,
          lastSetupError: setupIntent.last_setup_error || null,
        }
      : null,
    latestInvoice: attrs.latest_invoice || null,
    nextBillingSchedule: attrs.next_billing_schedule || null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function updateBillingPlanSchedules(billingPlan, schedules) {
  const scheduleById = new Map((schedules || []).map((schedule) => [schedule.id, schedule]));
  return {
    ...billingPlan,
    subscriptionSchedules: schedules,
    chunks: (billingPlan.chunks || []).map((chunk) => {
      if (!chunk.subscriptionScheduleId) return chunk;
      const schedule = scheduleById.get(chunk.subscriptionScheduleId);
      if (!schedule) return chunk;
      let status = chunk.status;
      if (schedule.status === "active") status = "subscription_active";
      if (schedule.status === "payment_issue") status = "payment_issue";
      if (schedule.status === "cancelled") status = "cancelled";
      if (schedule.status === "pending_setup") status = "subscription_pending";
      return {
        ...chunk,
        status,
        paymongoSubscriptionId: schedule.paymongoSubscriptionId || null,
        nextBillingSchedule: schedule.nextBillingSchedule || null,
      };
    }),
    updatedAt: new Date(),
  };
}

async function createProviderSubscriptionSchedules({
  billingPlan,
  checkout,
  customerId,
  currency,
  returnUrl,
  assetTitle,
}) {
  const schedules = billingPlan?.subscriptionSchedules || [];
  if (!schedules.length) return { billingPlan, nextAction: null };

  const createdSchedules = [];
  try {
    for (const schedule of schedules) {
      const metadata = compactMetadata({
        checkout_id: checkout.id,
        checkout_type: CHECKOUT_TYPE.booking,
        asset_id: checkout.assetId,
        renter_id: checkout.renterId,
        owner_id: checkout.ownerId,
        subscription_schedule_id: schedule.id,
        cadence: schedule.type,
      });
      const plan = await createSubscriptionPlan({
        amount: schedule.amount,
        currency,
        cycleCount: schedule.cycleCount,
        description: `Lend rental ${schedule.type} billing for ${assetTitle || checkout.assetId}`,
        interval: schedule.interval,
        intervalCount: schedule.intervalCount || 1,
        name: `Lend ${schedule.type} rental ${checkout.id} ${schedule.id}`,
        metadata,
      });
      const subscription = await createSubscription({
        anchorDate: schedule.anchorDate,
        customerId,
        planId: plan?.data?.id,
        returnUrl,
        metadata,
      });
      createdSchedules.push(subscriptionScheduleFromProvider(schedule, plan, subscription));
    }
  } catch (error) {
    await Promise.all(
      createdSchedules
        .filter((schedule) => schedule.paymongoSubscriptionId)
        .map((schedule) =>
          cancelCheckoutSubscriptions({
            checkout: {
              ...checkout,
              billingPlan: { ...billingPlan, subscriptionSchedules: [schedule] },
            },
            reason: "other",
          }).catch((cancelError) => {
            console.warn(
              `[createBookingPaymentSession] Failed to cancel created subscription ${schedule.paymongoSubscriptionId}: ${cancelError.message}`,
            );
          }),
        ),
    );
    throw error;
  }

  const updatedBillingPlan = updateBillingPlanSchedules(billingPlan, createdSchedules);
  return {
    billingPlan: updatedBillingPlan,
    nextAction: createdSchedules.map(subscriptionScheduleSetupIntent).find(Boolean) || null,
  };
}

async function createBookingPaymentSession(request) {
  const auth = request.auth;
  const { assetId, startDateMs, endDateMs, totalPrice, selectedPaymentMethod, selectedPaymentMethodDetails } =
    request.data || {};

  if (!auth) throwAndLogHttpsError("permission-denied", "User must be authenticated");
  if (!assetId || startDateMs == null || endDateMs == null || totalPrice == null) {
    throwAndLogHttpsError("invalid-argument", "Missing assetId, startDateMs, endDateMs, or totalPrice");
  }
  if (!Number.isInteger(totalPrice) || totalPrice <= 0) {
    throwAndLogHttpsError("invalid-argument", "Invalid totalPrice");
  }

  const paymentMethod = normalizeSelectedPaymentMethod(selectedPaymentMethod);
  const paymentMethodDetails = normalizeSelectedPaymentMethodDetails(selectedPaymentMethodDetails);
  const renterId = auth.uid;
  const bookingRange = normalizeBookingRange({ startDate: startDateMs, endDate: endDateMs });
  const db = admin.firestore();
  const assetRef = db.collection("assets").doc(assetId);
  const renterRef = db.collection("users").doc(renterId);
  const renterPaymentRef = userPaymentProfileRef(renterId);

  const [assetSnap, renterSnap, renterPaymentSnap] = await Promise.all([
    assetRef.get(),
    renterRef.get(),
    renterPaymentRef.get(),
  ]);
  if (!assetSnap.exists) throwAndLogHttpsError("not-found", "Asset not found");
  if (!renterSnap.exists) throwAndLogHttpsError("not-found", "Renter not found");

  const asset = assetSnap.data();
  const renter = renterSnap.data();
  if (!asset || asset.isDeleted === true || asset.status !== "Available") {
    throwAndLogHttpsError("failed-precondition", "Asset is unavailable");
  }
  if (!["Basic", "Full"].includes(renter.verified)) {
    throwAndLogHttpsError("failed-precondition", "Verify your email before booking");
  }
  if (!asset.ownerId || !asset.owner) throwAndLogHttpsError("failed-precondition", "Asset owner is missing");
  if (asset.ownerId === renterId) throwAndLogHttpsError("failed-precondition", "Owner cannot book their own asset");
  await assertUserCanReceiveNewBooking(db, asset.ownerId);
  await assertUsersCanInteract(db, renterId, asset.ownerId, "You cannot book this owner's listings");

  assertAssetMinimumNights(asset, bookingRange);

  let policy;
  let paymentMethodsConfig;
  let securityDeposit;
  let priceBreakdown;
  let billingPlan;
  try {
    [policy, paymentMethodsConfig] = await Promise.all([getPricingPolicyConfig(), getPaymentMethodsConfig()]);
    securityDeposit = normalizeSecurityDeposit(asset.securityDeposit);
    const billingChunks = buildRentalBillingChunks({ rates: asset.rates, bookingRange });
    const rentalSubtotal = subtotalFromBillingChunks(billingChunks);
    const legacyRentalSubtotal = calculateRentalSubtotal({ rates: asset.rates, bookingRange });
    if (legacyRentalSubtotal !== rentalSubtotal) {
      throw new Error("Booking total does not match current listing price");
    }
    if (Number(totalPrice) !== rentalSubtotal) {
      throw new Error("Booking total does not match current listing price");
    }
    const initialPriceBreakdown = buildBookingPriceBreakdown({
      rentalSubtotal,
      securityDeposit,
      policy,
      selectedPaymentMethod: paymentMethod,
      selectedPaymentMethodDetails: paymentMethodDetails,
      payerCountryShortName: renter?.location?.countryShortName,
      currency: listingCurrencyFromAsset(asset),
    });
    const initialBillingPlan = buildRecurringBillingPlan({
      rates: asset.rates,
      bookingRange,
      priceBreakdown: initialPriceBreakdown,
      securityDeposit,
    });
    priceBreakdown = buildBookingPriceBreakdown({
      rentalSubtotal,
      chargeableRentalSubtotal: initialBillingPlan.upfront.rentalAmountDueNow,
      securityDeposit,
      policy,
      selectedPaymentMethod: paymentMethod,
      selectedPaymentMethodDetails: paymentMethodDetails,
      payerCountryShortName: renter?.location?.countryShortName,
      currency: listingCurrencyFromAsset(asset),
    });
    billingPlan = buildRecurringBillingPlan({
      rates: asset.rates,
      bookingRange,
      priceBreakdown,
      securityDeposit,
    });
    assertPaymentMethodAvailable({
      config: paymentMethodsConfig,
      mode: billingPlan.isRecurring ? "subscription" : "upfront",
      paymentMethod,
      paymentMethodDetails,
    });
    assertRecurringPaymentMethodSupported({
      isRecurring: billingPlan.isRecurring,
      paymentMethod,
      paymentMethodDetails,
      throwError: throwAndLogHttpsError,
    });
  } catch (error) {
    if (error?.code) throw error;
    throwAndLogHttpsError("failed-precondition", error.message);
  }

  const renterPayment = renterPaymentSnap.data() || {};
  if (securityDeposit.enabled && renter.verified !== "Full") {
    throwAndLogHttpsError("failed-precondition", "Full verification is required to book listings with security deposits");
  }
  if (securityDeposit.enabled && !renterPayment.depositReturnDestination) {
    throwAndLogHttpsError("failed-precondition", "Add a security deposit return destination before booking this item");
  }

  const hasSubscriptionSchedules = (billingPlan.subscriptionSchedules || []).length > 0;
  let paymongoCustomerId = null;
  if (hasSubscriptionSchedules) {
    paymongoCustomerId = await getOrCreatePayMongoCustomerId({ uid: renterId, user: renter, auth });
  }

  const overlapSnap = await db
    .collection("assets")
    .doc(assetId)
    .collection("bookings")
    .where("startDate", "<", admin.firestore.Timestamp?.fromDate(bookingRange.endDate) || bookingRange.endDate)
    .where("endDate", ">", admin.firestore.Timestamp?.fromDate(bookingRange.startDate) || bookingRange.startDate)
    .where("status", "in", ACTIVE_BOOKING_STATUSES)
    .limit(1)
    .get();
  if (!overlapSnap.empty) throwAndLogHttpsError("already-exists", "Asset is unavailable for the selected dates");

  const checkoutRef = db.collection("paymentCheckouts").doc();
  const checkoutLockExpiresAtMs = Date.now() + resolveCheckoutLockExpiryMs({ paymentMethod, policy });
  const returnUrl = getPayMongoCheckoutReturnUrl(checkoutRef.id);
  const checkoutBase = {
    id: checkoutRef.id,
    checkoutId: checkoutRef.id,
    checkoutType: CHECKOUT_TYPE.booking,
    assetId,
    renterId,
    ownerId: asset.ownerId,
    startDateMs: bookingRange.startDate.getTime(),
    endDateMs: bookingRange.endDate.getTime(),
    numDays: bookingRange.numDays,
    totalPrice: priceBreakdown.rentalSubtotal,
    rentalSubtotal: priceBreakdown.rentalSubtotal,
    paymentAmount: priceBreakdown.paymentAmount,
    paymongoPaymentAmount: priceBreakdown.paymongoPaymentAmount,
    currency: priceBreakdown.currency,
    priceBreakdown,
    billingPlan,
    securityDeposit,
    selectedPaymentMethod: paymentMethod,
    selectedPaymentMethodDetails: paymentMethodDetails,
    shouldSaveCard: false,
    cardVaultingRequired: false,
    cardVaultingRequested: false,
    paymongoCustomerId,
    paymentIntentId: null,
    paymentIntentClientKey: null,
    paymentStatus: null,
    returnUrl,
    status: CHECKOUT_STATUS.initialized,
    checkoutLockExpiresAtMs,
    createdAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
  };

  try {
    await db.runTransaction(async (transaction) => {
      await reserveCheckoutDateLocks({
        transaction,
        checkoutId: checkoutRef.id,
        assetId,
        renterId,
        bookingRange,
        selectedPaymentMethod: paymentMethod,
        expiresAtMs: checkoutLockExpiresAtMs,
      });
      transaction.set(checkoutRef, checkoutBase);
    });
  } catch (error) {
    if (error?.message?.includes("temporarily reserved")) {
      throwAndLogHttpsError("already-exists", "Asset is temporarily reserved for the selected dates");
    }
    throw error;
  }

  let subscriptionSetupResult = { billingPlan, nextAction: null };
  if (hasSubscriptionSchedules) {
    try {
      subscriptionSetupResult = await createProviderSubscriptionSchedules({
        billingPlan,
        checkout: checkoutBase,
        customerId: paymongoCustomerId,
        currency: priceBreakdown.currency,
        returnUrl,
        assetTitle: asset.title,
      });
      billingPlan = subscriptionSetupResult.billingPlan;
      await checkoutRef.set(
        {
          billingPlan,
          nextAction: subscriptionSetupResult.nextAction || null,
          updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        },
        { merge: true },
      );
      await writeSubscriptionMappings({ checkout: checkoutBase, billingPlan });
    } catch (error) {
      await releaseCheckoutDateLocks({ checkout: checkoutBase, status: CHECKOUT_STATUS.failed }).catch((releaseError) => {
        console.warn(`[createBookingPaymentSession] Failed to release checkout locks: ${releaseError.message}`);
      });
      await checkoutRef.set(
        {
          status: CHECKOUT_STATUS.failed,
          lastPaymentError: error?.message || "Unable to create PayMongo Subscription",
          updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        },
        { merge: true },
      );
      const normalized = normalizePayMongoError(error);
      throwAndLogHttpsError("internal", `Unable to create PayMongo Subscription: ${normalized.message}`, normalized);
    }
  }

  let paymentIntent;
  try {
    paymentIntent = await createPaymentIntent({
      amount: priceBreakdown.paymentAmount,
      currency: priceBreakdown.currency,
      description: `Lend booking for ${asset.title || assetId}`,
      paymentMethods: [paymentMethod],
      metadata: {
        checkout_id: checkoutRef.id,
        checkout_type: CHECKOUT_TYPE.booking,
        billing_mode: billingPlan.isRecurring ? "recurring" : "one_time",
        asset_id: assetId,
        renter_id: renterId,
        owner_id: asset.ownerId,
        rental_subtotal: String(priceBreakdown.rentalSubtotal),
        due_now_rental_subtotal: String(priceBreakdown.dueNowRentalSubtotal),
        scheduled_rental_subtotal: String(priceBreakdown.scheduledRentalSubtotal),
        security_deposit_amount: String(priceBreakdown.securityDepositAmount),
      },
    });
  } catch (error) {
    await cancelCheckoutSubscriptions({ checkout: { ...checkoutBase, billingPlan }, reason: "other" }).catch((cancelError) => {
      console.warn(`[createBookingPaymentSession] Failed to cancel checkout subscriptions: ${cancelError.message}`);
    });
    await releaseCheckoutDateLocks({ checkout: checkoutBase, status: CHECKOUT_STATUS.failed }).catch((releaseError) => {
      console.warn(`[createBookingPaymentSession] Failed to release checkout locks: ${releaseError.message}`);
    });
    await checkoutRef.set(
      {
        status: CHECKOUT_STATUS.failed,
        updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      },
      { merge: true },
    );
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
    checkoutLockExpiresAtMs,
    amount: priceBreakdown.rentalSubtotal,
    paymentAmount: priceBreakdown.paymentAmount,
    renterProcessingFee: priceBreakdown.renterProcessingFee,
    paymongoPaymentAmount: priceBreakdown.paymongoPaymentAmount,
    priceBreakdown,
    pricingBreakdown: priceBreakdown,
    billingPlan,
    isRecurringBilling: billingPlan.isRecurring,
    nextSubscriptionAction: subscriptionSetupResult.nextAction || null,
    allowedPaymentMethods: allowedPayMongoMethodsForMode(
      paymentMethodsConfig,
      billingPlan.isRecurring ? "subscription" : "upfront",
    ),
  };
}

module.exports = { createBookingPaymentSession };
