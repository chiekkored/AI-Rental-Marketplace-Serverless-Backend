const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const { throwAndLogHttpsError } = require("../../../utils/error.util");
const {
  ACTIVE_BOOKING_STATUSES,
  BOOKING_STATUS,
  CHAT_STATUS,
  buildBookingMirrorUpdate,
  buildTokenUpdateData,
  formatBookingPurpose,
  formatBookingStartDate,
  formatBookingSubject,
  getBookingActors,
  getBookingRefs,
  getLifecycleMessageId,
  normalizeBookingRange,
  normalizeSecurityDeposit,
} = require("../../../utils/booking.util");
const { firstListingImageUrl, sendNotificationToUser } = require("../../../utils/notification.util");
const { USER_STATUS } = require("../../account/deactivation");
const {
  sendPaymentFailedEmail,
  sendPaymentReceiptEmail,
  sendPayoutEmail,
} = require("../../../utils/transactionalEmail.util");
const { pendingBookingCountIncrementValue } = require("../../../utils/pendingBookingCount.util");
const { updateRecommendationProfile } = require("../../../utils/recommendations.util");
const {
  calculateFee,
  calculatePaymentMethodFee,
  getPricingPolicyConfig,
  resolveCheckoutLockExpiryMs,
  resolvePaymentMethodFee,
} = require("../../../utils/remoteConfig.util");
const {
  attachPaymentMethod,
  cancelSubscription,
  createCustomer,
  createPaymentIntent,
  createSubscription,
  createSubscriptionPlan,
  createWalletTransaction,
  getPayMongoCheckoutReturnUrl,
  getPayMongoPublicKey,
  getPayMongoWalletId,
  getPayMongoWebhookUrl,
  listCustomerPaymentMethods,
  listReceivingInstitutions,
  normalizePayMongoError,
  retrievePaymentIntent,
  retrieveSubscription,
  toPayMongoAmount,
  updatePaymentMethodCvc,
  verifyWebhookSignature,
} = require("../../../utils/paymongo.util");

const CHECKOUT_STATUS = {
  initialized: "initialized",
  processing: "processing",
  subscriptionPending: "subscription_pending",
  paid: "paid",
  booked: "booked",
  failed: "failed",
  expired: "expired",
  cancelled: "cancelled",
};

const CHECKOUT_TYPE = {
  booking: "booking",
  outstandingDamage: "outstanding_damage",
};

const PAYOUT_STATUS = {
  pending: "pending",
  processing: "processing",
  succeeded: "succeeded",
  failed: "failed",
  configurationRequired: "configuration_required",
  missingDestination: "missing_destination",
  skipped: "skipped",
  cancelled: "cancelled",
};

const SUPPORT_CHAT_TYPE = "lend_support";
const DEPOSIT_RETURN_PROCESSING_DAYS_TEXT = "7 business days";
const OWNER_PAYOUT_MOVEMENT_TYPES = new Set(["owner_payout", "renter_cancellation_owner_payout"]);
const OWNER_CANCELLATION_PENALTY_STATUS = {
  open: "open",
  partiallyApplied: "partially_applied",
  applied: "applied",
};
const OPEN_OWNER_CANCELLATION_PENALTY_STATUSES = [
  OWNER_CANCELLATION_PENALTY_STATUS.open,
  OWNER_CANCELLATION_PENALTY_STATUS.partiallyApplied,
];

const DEPOSIT_FLOW_STATUS = {
  none: "none",
  held: "held",
  awaitingOwnerAction: "awaiting_owner_action",
  awaitingRenterResponse: "awaiting_renter_response",
  accepted: "accepted",
  disputed: "disputed",
  supportReview: "support_review",
  returnProcessing: "return_processing",
  returned: "returned",
  deducted: "deducted",
  partiallyReturned: "partially_returned",
  outstandingPaymentPending: "outstanding_payment_pending",
  completed: "completed",
};

const DISPUTE_STATUS = {
  requested: "requested",
  accepted: "accepted",
  disputed: "disputed",
  supportReview: "support_review",
  outstandingPaymentPending: "outstanding_payment_pending",
  outstandingPaid: "outstanding_paid",
  resolved: "resolved",
};

const LOCKED_CHECKOUT_STATUSES = [
  CHECKOUT_STATUS.initialized,
  CHECKOUT_STATUS.processing,
  CHECKOUT_STATUS.subscriptionPending,
];

function paymentCheckoutRef(checkoutId) {
  return admin.firestore().collection("paymentCheckouts").doc(checkoutId);
}

function userPaymentProfileRef(uid) {
  return admin.firestore().doc(`users/${uid}/private/payment`);
}

function normalizePayMongoCustomerText(value, fallback) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
}

function normalizePayMongoCustomerPhone(value) {
  const normalized = typeof value === "string" ? value.replace(/[^\d+]/g, "").trim() : "";
  return normalized || null;
}

function authEmail(auth) {
  return normalizePayMongoCustomerText(auth?.token?.email || auth?.email, null);
}

async function getOrCreatePayMongoCustomerId({ uid, user, auth }) {
  if (!uid) throw new Error("Missing user ID for PayMongo customer");
  const paymentRef = userPaymentProfileRef(uid);
  const existingSnap = await paymentRef.get();
  const existingCustomerId = normalizePayMongoCustomerText(existingSnap.data()?.paymongoCustomerId, null);
  if (existingCustomerId) return existingCustomerId;

  const email = normalizePayMongoCustomerText(user?.email || authEmail(auth), `${uid}@lend.invalid`);
  const customer = await createCustomer({
    firstName: normalizePayMongoCustomerText(user?.firstName, "Lend"),
    lastName: normalizePayMongoCustomerText(user?.lastName, "Customer"),
    email,
    phone: normalizePayMongoCustomerPhone(user?.phone),
    metadata: { lend_uid: uid },
  });
  const customerId = customer?.data?.id;
  if (!customerId) throw new Error("PayMongo did not return a customer ID");

  await paymentRef.set(
    {
      paymongoCustomerId: customerId,
      paymongoCustomerCreatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    },
    { merge: true },
  );
  return customerId;
}

function bookingMovementRef(id) {
  return admin.firestore().collection("bookingPayouts").doc(id);
}

function normalizeCurrency(currency) {
  const normalized = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  return normalized || "PHP";
}

function bookingCurrency(booking) {
  return normalizeCurrency(booking?.paymentFlow?.currency || booking?.asset?.rates?.currency);
}

function listingCurrencyFromAsset(asset) {
  return normalizeCurrency(asset?.rates?.currency);
}

function checkoutDateLockRefs({ assetId, startDate, endDate }) {
  const refs = [];
  const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));
  while (cursor < end) {
    refs.push(
      admin
        .firestore()
        .collection("assets")
        .doc(assetId)
        .collection("bookingDateLocks")
        .doc(cursor.toISOString().slice(0, 10)),
    );
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return refs;
}

async function reserveCheckoutDateLocks({
  transaction,
  checkoutId,
  assetId,
  renterId,
  bookingRange,
  selectedPaymentMethod,
  expiresAtMs,
}) {
  const lockRefs = checkoutDateLockRefs({
    assetId,
    startDate: bookingRange.startDate,
    endDate: bookingRange.endDate,
  });
  const nowMs = Date.now();

  for (const lockRef of lockRefs) {
    const lockSnap = await transaction.get(lockRef);
    const lock = lockSnap.data();
    if (
      lockSnap.exists &&
      lock.checkoutId !== checkoutId &&
      lock.expiresAtMs > nowMs &&
      LOCKED_CHECKOUT_STATUSES.includes(lock.status)
    ) {
      throw new Error("Asset is temporarily reserved for the selected dates");
    }
  }

  for (const lockRef of lockRefs) {
    transaction.set(
      lockRef,
      {
        checkoutId,
        assetId,
        renterId,
        status: CHECKOUT_STATUS.initialized,
        selectedPaymentMethod,
        expiresAtMs,
        updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      },
      { merge: true },
    );
  }
}

async function releaseCheckoutDateLocks({ checkout, status }) {
  if (!checkout?.assetId || checkout.startDateMs == null || checkout.endDateMs == null) return;

  const bookingRange = normalizeBookingRange({
    startDate: checkout.startDateMs,
    endDate: checkout.endDateMs,
  });
  const lockRefs = checkoutDateLockRefs({
    assetId: checkout.assetId,
    startDate: bookingRange.startDate,
    endDate: bookingRange.endDate,
  });
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();

  await admin.firestore().runTransaction(async (transaction) => {
    const snaps = [];
    for (const ref of lockRefs) {
      snaps.push({ ref, snap: await transaction.get(ref) });
    }
    for (const { ref, snap } of snaps) {
      const lock = snap.data();
      if (!snap.exists || lock?.checkoutId !== checkout.id) continue;
      transaction.set(
        ref,
        { checkoutId: checkout.id, status, expiresAtMs: Date.now(), updatedAt: now },
        { merge: true },
      );
    }
  });
}

function calculateRentalSubtotal({ rates, bookingRange }) {
  if (!rates || typeof rates !== "object") {
    throw new Error("Asset rates are missing");
  }

  let total = 0;
  let currentDate = new Date(
    bookingRange.startDate.getFullYear(),
    bookingRange.startDate.getMonth(),
    bookingRange.startDate.getDate(),
  );
  const endDate = new Date(
    bookingRange.endDate.getFullYear(),
    bookingRange.endDate.getMonth(),
    bookingRange.endDate.getDate(),
  );

  while (currentDate < endDate) {
    if (Number.isInteger(rates.annually)) {
      const nextYear = new Date(currentDate.getFullYear() + 1, currentDate.getMonth(), currentDate.getDate());
      if (nextYear <= endDate) {
        total += rates.annually;
        currentDate = nextYear;
        continue;
      }
    }

    if (Number.isInteger(rates.monthly)) {
      const nextMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, currentDate.getDate());
      if (nextMonth <= endDate) {
        total += rates.monthly;
        currentDate = nextMonth;
        continue;
      }
    }

    if (Number.isInteger(rates.weekly)) {
      const nextWeek = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate() + 7);
      if (nextWeek <= endDate) {
        total += rates.weekly;
        currentDate = nextWeek;
        continue;
      }
    }

    if (!Number.isInteger(rates.daily) || rates.daily <= 0) {
      throw new Error("Daily rate is required to calculate booking price");
    }
    total += rates.daily;
    currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate() + 1);
  }

  if (!Number.isInteger(total) || total <= 0) {
    throw new Error("Unable to calculate booking price");
  }
  return total;
}

function roundCurrency(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function buildBookingPriceBreakdown({
  rentalSubtotal,
  chargeableRentalSubtotal,
  securityDeposit,
  policy,
  selectedPaymentMethod,
  selectedPaymentMethodDetails,
  payerCountryShortName,
  currency,
}) {
  const securityDepositAmount = securityDeposit?.enabled ? Number(securityDeposit.amount || 0) : 0;
  const dueNowRentalSubtotal =
    chargeableRentalSubtotal == null ? rentalSubtotal : roundCurrency(Math.max(Number(chargeableRentalSubtotal || 0), 0));
  const renterFeeRule = resolvePaymentMethodFee({
    policy,
    paymentMethod: selectedPaymentMethod,
    details: selectedPaymentMethodDetails,
    payerCountryShortName,
  });
  const ownerDepositCollectionFeeRule = resolvePaymentMethodFee({
    policy,
    paymentMethod: selectedPaymentMethod,
    details: selectedPaymentMethodDetails,
  });
  const renterPlatformFee = roundCurrency(calculateFee(dueNowRentalSubtotal, policy.fees.platform));
  const renterProcessingBaseAmount = roundCurrency(dueNowRentalSubtotal + renterPlatformFee);
  const renterProcessingFee = calculatePaymentMethodFee(renterProcessingBaseAmount, renterFeeRule.fee, policy);
  const securityDepositCollectionProcessingFee =
    securityDepositAmount > 0
      ? calculatePaymentMethodFee(securityDepositAmount, ownerDepositCollectionFeeRule.fee, policy)
      : 0;
  const ownerTransferFees = calculateWalletTransferFeeBreakdown(rentalSubtotal, policy.fees);
  const depositReturnTransferFees =
    securityDepositAmount > 0
      ? calculateWalletTransferFeeBreakdown(securityDepositAmount, policy.fees)
      : emptyWalletTransferFeeBreakdown();
  const ownerPayoutTransferFee = ownerTransferFees.total;
  const renterDepositReturnTransferFee = depositReturnTransferFees.total;
  const ownerProcessingFee = roundCurrency(
    securityDepositCollectionProcessingFee + ownerPayoutTransferFee + renterDepositReturnTransferFee,
  );
  const paymentAmount = roundCurrency(
    dueNowRentalSubtotal + renterPlatformFee + renterProcessingFee + securityDepositAmount,
  );
  const ownerPayoutAmount = roundCurrency(Math.max(rentalSubtotal - ownerProcessingFee, 0));

  return {
    rentalSubtotal,
    durationAmount: rentalSubtotal,
    chargeableRentalSubtotal: dueNowRentalSubtotal,
    dueNowRentalSubtotal,
    scheduledRentalSubtotal: roundCurrency(Math.max(rentalSubtotal - dueNowRentalSubtotal, 0)),
    renterPlatformFee,
    renterProcessingBaseAmount,
    renterProcessingFee,
    securityDepositAmount,
    securityDepositIncludedInPaymongoFee: false,
    securityDepositCollectionProcessingFee,
    ownerPayoutTransferProviderFee: ownerTransferFees.provider,
    ownerPayoutTransferMarkupFee: ownerTransferFees.markup,
    ownerPayoutTransferFee,
    renterDepositReturnTransferProviderFee: depositReturnTransferFees.provider,
    renterDepositReturnTransferMarkupFee: depositReturnTransferFees.markup,
    renterDepositReturnTransferFee,
    ownerProcessingFee,
    paymentAmount,
    paymongoPaymentAmount: toPayMongoAmount(paymentAmount),
    ownerPayoutAmount,
    currency: normalizeCurrency(currency),
    paymentMethod: {
      method: renterFeeRule.method,
      bankCode: renterFeeRule.bankCode || null,
      label: renterFeeRule.label,
      source: renterFeeRule.source,
      rateBps: renterFeeRule.fee.rateBps,
      fixedAmount: renterFeeRule.fee.fixedAmount,
      calculation: renterFeeRule.fee.calculation,
      vatRateBps: policy.paymentMethodFeeVatRateBps,
    },
    platformFeeRule: {
      rateBps: policy.fees.platform.rateBps,
      fixedAmount: policy.fees.platform.fixedAmount,
      calculation: policy.fees.platform.calculation,
    },
    transferFeeProviderRule: {
      rateBps: policy.fees.walletTransferProvider.rateBps,
      fixedAmount: policy.fees.walletTransferProvider.fixedAmount,
      calculation: policy.fees.walletTransferProvider.calculation,
    },
    transferFeeMarkupRule: {
      rateBps: policy.fees.walletTransferMarkup.rateBps,
      fixedAmount: policy.fees.walletTransferMarkup.fixedAmount,
      calculation: policy.fees.walletTransferMarkup.calculation,
    },
    transferFeeRule: {
      rateBps: policy.fees.walletTransferProvider.rateBps,
      fixedAmount: policy.fees.walletTransferProvider.fixedAmount,
      calculation: policy.fees.walletTransferProvider.calculation,
    },
  };
}

function calculateWalletTransferFeeBreakdown(amount, fees) {
  const normalizedAmount = Math.max(Number(amount || 0), 0);
  if (normalizedAmount <= 0) return emptyWalletTransferFeeBreakdown();

  const provider = roundCurrency(calculateFee(normalizedAmount, fees.walletTransferProvider));
  const markup = roundCurrency(calculateFee(normalizedAmount, fees.walletTransferMarkup));
  return {
    provider,
    markup,
    total: roundCurrency(provider + markup),
  };
}

function emptyWalletTransferFeeBreakdown() {
  return { provider: 0, markup: 0, total: 0 };
}

function buildOutstandingDamagePriceBreakdown({
  amount,
  policy,
  selectedPaymentMethod,
  selectedPaymentMethodDetails,
  payerCountryShortName,
  currency,
}) {
  const feeRule = resolvePaymentMethodFee({
    policy,
    paymentMethod: selectedPaymentMethod,
    details: selectedPaymentMethodDetails,
    payerCountryShortName,
  });
  const renterProcessingFee = calculatePaymentMethodFee(amount, feeRule.fee, policy);
  const paymentAmount = roundCurrency(amount + renterProcessingFee);

  return {
    outstandingDamageAmount: amount,
    renterProcessingFee,
    paymentAmount,
    paymongoPaymentAmount: toPayMongoAmount(paymentAmount),
    currency: normalizeCurrency(currency),
    paymentMethod: {
      method: feeRule.method,
      bankCode: feeRule.bankCode || null,
      label: feeRule.label,
      source: feeRule.source,
      rateBps: feeRule.fee.rateBps,
      fixedAmount: feeRule.fee.fixedAmount,
      calculation: feeRule.fee.calculation,
      vatRateBps: policy.paymentMethodFeeVatRateBps,
    },
  };
}

function normalizeSelectedPaymentMethod(method) {
  const normalized = typeof method === "string" && method.trim() ? method.trim() : "card";
  return normalized;
}

function normalizeSelectedPaymentMethodDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  const normalized = {};
  const bankCode = typeof details.bank_code === "string" ? details.bank_code.trim().toLowerCase() : "";
  if (bankCode) normalized.bank_code = bankCode.slice(0, 40);
  const cardBrand = typeof details.card_brand === "string" ? details.card_brand.trim().toLowerCase() : "";
  if (cardBrand) normalized.card_brand = cardBrand.slice(0, 40);
  const last4 = typeof details.last4 === "string" ? details.last4.replace(/\D/g, "") : "";
  if (last4.length === 4) normalized.last4 = last4;
  return normalized;
}

function toSimpleUser(user, uid) {
  const displayName = resolveMarketplaceDisplayName(user);
  return {
    uid,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    displayName,
    photoUrl: user.photoUrl || null,
    verified: user.verified || "None",
    status: user.status || "Active",
    userMetadataVersion: user.userMetadataVersion || 1,
  };
}

function resolveMarketplaceDisplayName(user) {
  const businessName = typeof user?.businessRegistration?.businessName === "string"
    ? user.businessRegistration.businessName.trim()
    : "";
  const businessApproved = user?.businessRegistration?.status === "Approved";
  return user?.useBusinessNameForListingOwnerName === true && businessApproved && businessName
    ? businessName
    : null;
}

function toAssetSnapshot(asset, assetId) {
  return {
    ...asset,
    id: assetId,
    securityDeposit: normalizeSecurityDeposit(asset.securityDeposit),
    ownerInstructions: asset.ownerInstructions || null,
    blocksEndDate: asset.blocksEndDate === true,
  };
}

function paymentIntentAttributes(paymentIntent) {
  return paymentIntent?.data?.attributes || {};
}

function paymentIntentId(paymentIntent) {
  return paymentIntent?.data?.id || null;
}

function latestPayment(paymentIntent) {
  const payments = paymentIntentAttributes(paymentIntent).payments;
  if (!Array.isArray(payments) || payments.length === 0) return null;
  return payments[payments.length - 1];
}

function latestPaymentAttributes(paymentIntent) {
  const payment = latestPayment(paymentIntent);
  return payment?.data?.attributes || payment?.attributes || {};
}

function extractPaymentMethodType(paymentIntent, fallback) {
  const attrs = latestPaymentAttributes(paymentIntent);
  return attrs?.source?.type || attrs?.payment_method_type || fallback || null;
}

function extractPaymentId(paymentIntent) {
  const payment = latestPayment(paymentIntent);
  return payment?.data?.id || payment?.id || null;
}

function buildPaymentFlow({ paymentIntent, checkout }) {
  const attrs = paymentIntentAttributes(paymentIntent);
  const paymentAttrs = latestPaymentAttributes(paymentIntent);
  const method = extractPaymentMethodType(paymentIntent, checkout?.selectedPaymentMethod);
  return {
    provider: "paymongo",
    checkoutId: checkout?.id || null,
    method,
    methodDetails: checkout?.selectedPaymentMethodDetails || {},
    transactionId: extractPaymentId(paymentIntent) || paymentIntentId(paymentIntent),
    paymongoPaymentIntentId: paymentIntentId(paymentIntent),
    paymongoPaymentId: extractPaymentId(paymentIntent),
    paymongoCustomerId: checkout?.paymongoCustomerId || null,
    selectedCustomerPaymentMethodId: checkout?.selectedCustomerPaymentMethodId || null,
    selectedPaymongoPaymentMethodId: checkout?.selectedPaymongoPaymentMethodId || null,
    amount: Number(checkout?.priceBreakdown?.paymentAmount || checkout?.paymentAmount || 0) || null,
    paymongoAmount: Number(attrs.amount || 0) || null,
    currency: normalizeCurrency(attrs.currency || checkout?.currency),
    status: "paid",
    paidAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    paymongoFee: Number(paymentAttrs.fee || 0) || null,
    paymongoNetAmount: Number(paymentAttrs.net_amount || 0) || null,
  };
}

function subscriptionAttributes(subscription) {
  return subscription?.data?.attributes || subscription?.attributes || {};
}

function subscriptionId(subscription) {
  return subscription?.data?.id || subscription?.id || null;
}

function normalizeSubscriptionSetupIntent(setupIntent) {
  if (!setupIntent || typeof setupIntent !== "object") return null;
  return {
    id: setupIntent.id || null,
    status: setupIntent.status || null,
    nextActionUrl: setupIntent.next_action_url || null,
    lastSetupError: setupIntent.last_setup_error || null,
  };
}

function nextActionFromSubscription(subscription) {
  const setupIntent = subscriptionAttributes(subscription).setup_intent;
  const url = setupIntent?.next_action_url;
  if (!url) return null;
  return {
    type: "redirect",
    redirect: { url },
    url,
    source: "paymongo_subscription_setup",
    setupIntentId: setupIntent.id || null,
  };
}

function normalizeSubscriptionProviderStatus(status) {
  if (status === "active") return "active";
  if (status === "cancelled" || status === "incomplete_cancelled") return "cancelled";
  if (status === "past_due" || status === "unpaid") return "payment_issue";
  return "pending_setup";
}

function mergeSubscriptionScheduleFromProvider(schedule, subscription) {
  const attrs = subscriptionAttributes(subscription);
  const providerStatus = attrs.status || schedule.providerStatus || null;
  return {
    ...schedule,
    status: normalizeSubscriptionProviderStatus(providerStatus),
    providerStatus,
    paymongoPlanId: attrs.plan?.id || schedule.paymongoPlanId || null,
    paymongoSubscriptionId: subscriptionId(subscription) || schedule.paymongoSubscriptionId || null,
    defaultCustomerPaymentMethodId:
      attrs.default_customer_payment_method_id || schedule.defaultCustomerPaymentMethodId || null,
    setupIntent: normalizeSubscriptionSetupIntent(attrs.setup_intent),
    latestInvoice: attrs.latest_invoice || schedule.latestInvoice || null,
    nextBillingSchedule: attrs.next_billing_schedule || schedule.nextBillingSchedule || null,
    cancelledAt: attrs.cancelled_at || schedule.cancelledAt || null,
    lastSyncedAt: new Date(),
  };
}

function updateChunksForSubscriptionSchedules(chunks = [], schedules = []) {
  const scheduleById = new Map(schedules.map((schedule) => [schedule.id, schedule]));
  return (chunks || []).map((chunk) => {
    if (!chunk.subscriptionScheduleId) return chunk;
    const schedule = scheduleById.get(chunk.subscriptionScheduleId);
    if (!schedule) return chunk;
    let status = chunk.status;
    if (schedule.status === "active") status = "subscription_active";
    if (schedule.status === "cancelled") status = "cancelled";
    if (schedule.status === "payment_issue") status = "payment_issue";
    if (schedule.status === "pending_setup") status = "subscription_pending";
    return {
      ...chunk,
      status,
      paymongoSubscriptionId: schedule.paymongoSubscriptionId || chunk.paymongoSubscriptionId || null,
      nextBillingSchedule: schedule.nextBillingSchedule || chunk.nextBillingSchedule || null,
      lastPaymentError: schedule.setupIntent?.lastSetupError || chunk.lastPaymentError || null,
    };
  });
}

function subscriptionMappingRef(subscriptionIdValue) {
  if (!subscriptionIdValue) return null;
  return admin.firestore().collection("paymongoSubscriptions").doc(subscriptionIdValue);
}

async function writeSubscriptionMappings({ checkout, billingPlan }) {
  const schedules = billingPlan?.subscriptionSchedules || [];
  const writes = schedules
    .filter((schedule) => schedule.paymongoSubscriptionId)
    .map((schedule) =>
      subscriptionMappingRef(schedule.paymongoSubscriptionId).set(
        {
          checkoutId: checkout.id,
          bookingId: checkout.bookingId || null,
          assetId: checkout.assetId || null,
          renterId: checkout.renterId || null,
          ownerId: checkout.ownerId || null,
          scheduleId: schedule.id,
          paymongoPlanId: schedule.paymongoPlanId || null,
          paymongoSubscriptionId: schedule.paymongoSubscriptionId,
          status: schedule.status || null,
          updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
          createdAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        },
        { merge: true },
      ),
    );
  await Promise.all(writes);
}

async function refreshCheckoutSubscriptions({ checkout }) {
  const schedules = checkout?.billingPlan?.subscriptionSchedules || [];
  if (!schedules.length) {
    return { ready: true, billingPlan: checkout?.billingPlan || null, nextAction: null };
  }

  const refreshedSchedules = [];
  let nextAction = null;
  for (const schedule of schedules) {
    if (!schedule.paymongoSubscriptionId) {
      refreshedSchedules.push({ ...schedule, status: "pending_setup" });
      continue;
    }
    const subscription = await retrieveSubscription(schedule.paymongoSubscriptionId);
    const refreshed = mergeSubscriptionScheduleFromProvider(schedule, subscription);
    refreshedSchedules.push(refreshed);
    nextAction = nextAction || nextActionFromSubscription(subscription);
  }

  const billingPlan = {
    ...(checkout.billingPlan || {}),
    status: refreshedSchedules.some((schedule) => schedule.status === "payment_issue")
      ? "payment_issue"
      : refreshedSchedules.every((schedule) => schedule.status === "active")
        ? "scheduled"
        : "scheduled",
    subscriptionSchedules: refreshedSchedules,
    chunks: updateChunksForSubscriptionSchedules(checkout.billingPlan?.chunks || [], refreshedSchedules),
    updatedAt: new Date(),
  };
  const ready = refreshedSchedules.every((schedule) => schedule.status === "active");
  return { ready, billingPlan, nextAction, schedules: refreshedSchedules };
}

async function cancelCheckoutSubscriptions({ checkout, reason = "other" }) {
  const schedules = checkout?.billingPlan?.subscriptionSchedules || [];
  if (!schedules.length) return { billingPlan: checkout?.billingPlan || null, errors: [] };

  const errors = [];
  const updatedSchedules = [];
  for (const schedule of schedules) {
    if (!schedule.paymongoSubscriptionId || schedule.status === "cancelled") {
      updatedSchedules.push(schedule);
      continue;
    }
    try {
      const subscription = await cancelSubscription({ subscriptionId: schedule.paymongoSubscriptionId, reason });
      updatedSchedules.push(mergeSubscriptionScheduleFromProvider({ ...schedule, status: "cancelled" }, subscription));
    } catch (error) {
      const normalized = normalizePayMongoError(error);
      errors.push({
        scheduleId: schedule.id || null,
        paymongoSubscriptionId: schedule.paymongoSubscriptionId,
        message: normalized.message,
      });
      updatedSchedules.push({
        ...schedule,
        cancellationError: normalized.message,
        cancellationErrorAt: new Date(),
      });
    }
  }

  const billingPlan = {
    ...(checkout.billingPlan || {}),
    subscriptionSchedules: updatedSchedules,
    chunks: updateChunksForSubscriptionSchedules(checkout.billingPlan?.chunks || [], updatedSchedules),
    subscriptionCancellationErrors: errors.length ? errors : null,
    updatedAt: new Date(),
  };
  await paymentCheckoutRef(checkout.id).set(
    {
      billingPlan,
      subscriptionCancellationErrors: errors.length ? errors : null,
      updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    },
    { merge: true },
  );
  await writeSubscriptionMappings({ checkout, billingPlan });
  return { billingPlan, errors };
}

async function createConfirmedBookingFromCheckout({ checkoutId, paymentIntent, source = "sync" }) {
  const db = admin.firestore();
  const checkoutRef = paymentCheckoutRef(checkoutId);
  let confirmResult = null;

  await db.runTransaction(async (transaction) => {
    const checkoutSnap = await transaction.get(checkoutRef);
    if (!checkoutSnap.exists) throw new Error("Payment checkout not found");
    const checkout = { id: checkoutSnap.id, ...checkoutSnap.data() };
    if (checkout.status === CHECKOUT_STATUS.booked && checkout.bookingId) {
      confirmResult = {
        alreadyBooked: true,
        bookingId: checkout.bookingId,
        chatId: checkout.chatId,
        assetId: checkout.assetId,
        renterId: checkout.renterId,
      };
      return;
    }

    const attrs = paymentIntentAttributes(paymentIntent);
    if (paymentIntentId(paymentIntent) !== checkout.paymentIntentId) {
      throw new Error("Payment Intent does not match checkout");
    }
    if (attrs.status !== "succeeded") {
      transaction.set(
        checkoutRef,
        {
          status: attrs.status || CHECKOUT_STATUS.processing,
          lastPaymentStatus: attrs.status || null,
          lastSyncedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        },
        { merge: true },
      );
      confirmResult = { alreadyBooked: false, pending: true, paymentStatus: attrs.status || null };
      return;
    }

    const expectedPaymongoAmount =
      Number(checkout.paymongoPaymentAmount || 0) || toPayMongoAmount(checkout.paymentAmount);
    if (Number(attrs.amount) !== expectedPaymongoAmount) {
      throw new Error("Paid amount does not match checkout total");
    }

    const assetRef = db.collection("assets").doc(checkout.assetId);
    const renterRef = db.collection("users").doc(checkout.renterId);
    const [assetSnap, renterSnap] = await Promise.all([transaction.get(assetRef), transaction.get(renterRef)]);
    if (!assetSnap.exists) throw new Error("Asset not found");
    if (!renterSnap.exists) throw new Error("Renter not found");
    const asset = assetSnap.data();
    const renter = renterSnap.data();
    if (!asset || asset.isDeleted === true || asset.status !== "Available") {
      throw new Error("Asset is unavailable");
    }
    if (asset.ownerId === checkout.renterId) throw new Error("Owner cannot book their own asset");
    const ownerSnap = await transaction.get(db.collection("users").doc(asset.ownerId));
    if (!ownerSnap.exists) throw new Error("Asset owner account is unavailable");
    if (
      [USER_STATUS.deactivated, USER_STATUS.deleted, USER_STATUS.disabled].includes(
        ownerSnap.data()?.status,
      )
    ) {
      throw new Error("This owner is not accepting new bookings");
    }

    const bookingRange = normalizeBookingRange({ startDate: checkout.startDateMs, endDate: checkout.endDateMs });
    const activeOverlapQuery = db
      .collection("assets")
      .doc(checkout.assetId)
      .collection("bookings")
      .where("startDate", "<", admin.firestore.Timestamp?.fromDate(bookingRange.endDate) || bookingRange.endDate)
      .where("endDate", ">", admin.firestore.Timestamp?.fromDate(bookingRange.startDate) || bookingRange.startDate)
      .where("status", "in", ACTIVE_BOOKING_STATUSES);
    const activeOverlapSnap = await transaction.get(activeOverlapQuery);
    if (!activeOverlapSnap.empty) throw new Error("Asset is unavailable for the selected dates");

    const bookingRef = db.collection("users").doc(checkout.renterId).collection("bookings").doc();
    const rootBookingRef = db.collection("bookings").doc(bookingRef.id);
    const assetBookingRef = db.collection("assets").doc(checkout.assetId).collection("bookings").doc(bookingRef.id);
    const chatRef = db.collection("chats").doc();
    const messageRef = chatRef.collection("messages").doc();
    const renterUserChatRootRef = db.collection("userChats").doc(checkout.renterId);
    const renterUserChatRef = renterUserChatRootRef.collection("chats").doc(chatRef.id);
    const ownerUserChatRootRef = db.collection("userChats").doc(asset.ownerId);
    const ownerUserChatRef = ownerUserChatRootRef.collection("chats").doc(chatRef.id);
    const ownerAssetMirrorRef = db.collection("users").doc(asset.ownerId).collection("assets").doc(checkout.assetId);
    const ownerAssetMirrorSnap = await transaction.get(ownerAssetMirrorRef);
    const dateLockRefs = checkoutDateLockRefs({
      assetId: checkout.assetId,
      startDate: bookingRange.startDate,
      endDate: bookingRange.endDate,
    });

    const renterSnapshot = toSimpleUser(renter, checkout.renterId);
    const assetSnapshot = toAssetSnapshot(asset, checkout.assetId);
    const tokenData = buildTokenUpdateData({
      bookingId: bookingRef.id,
      renterId: checkout.renterId,
      assetId: checkout.assetId,
      endDate: admin.firestore.Timestamp?.fromDate(bookingRange.endDate) || bookingRange.endDate,
      existingTokens: null,
    });
    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
    const bookingText = formatBookingPurpose(
      { asset: assetSnapshot, startDate: bookingRange.startDate },
      "was confirmed.",
      "A booking",
    );
    const securityDeposit = checkout.securityDeposit || { enabled: false, amount: 0 };
    const priceBreakdown = checkout.priceBreakdown || {};
    const bookingPayload = {
      id: bookingRef.id,
      chatId: chatRef.id,
      asset: assetSnapshot,
      createdAt: now,
      startDate: admin.firestore.Timestamp?.fromDate(bookingRange.startDate) || bookingRange.startDate,
      endDate: admin.firestore.Timestamp?.fromDate(bookingRange.endDate) || bookingRange.endDate,
      numDays: bookingRange.numDays,
      paymentFlow: buildPaymentFlow({ paymentIntent, checkout }),
      billingPlan: checkout.billingPlan || null,
      priceBreakdown,
      renter: renterSnapshot,
      status: BOOKING_STATUS.confirmed,
      totalPrice: priceBreakdown.rentalSubtotal || checkout.totalPrice,
      securityDeposit,
      depositFlow: {
        required: securityDeposit.enabled === true,
        amount: securityDeposit.enabled ? Number(securityDeposit.amount || 0) : 0,
        status: securityDeposit.enabled ? DEPOSIT_FLOW_STATUS.held : DEPOSIT_FLOW_STATUS.none,
        renterReturnDestinationRequired: securityDeposit.enabled === true,
        updatedAt: now,
      },
      disputeFlow: null,
      payoutFlow: {
        ownerPayoutStatus: PAYOUT_STATUS.pending,
        depositReturnStatus: securityDeposit.enabled ? PAYOUT_STATUS.pending : PAYOUT_STATUS.skipped,
        updatedAt: now,
      },
      tokens: tokenData.tokens,
      lastUpdated: now,
    };

    const chatPayload = {
      id: chatRef.id,
      chatId: chatRef.id,
      bookingId: bookingRef.id,
      renterId: checkout.renterId,
      bookingStartDate: bookingPayload.startDate,
      bookingEndDate: bookingPayload.endDate,
      bookingStatus: bookingPayload.status,
      asset: assetSnapshot,
      participants: [asset.owner, renterSnapshot],
      participantIds: [asset.ownerId, checkout.renterId],
      lastMessage: bookingText,
      lastMessageDate: now,
      lastMessageSenderId: "",
      createdAt: now,
      hasRead: false,
      status: CHAT_STATUS.active,
    };

    transaction.set(rootBookingRef, bookingPayload);
    transaction.set(bookingRef, buildBookingMirrorUpdate(bookingPayload));
    transaction.set(assetBookingRef, buildBookingMirrorUpdate(bookingPayload));
    transaction.set(chatRef, { chatType: "Private" });
    transaction.set(messageRef, {
      id: messageRef.id,
      text: bookingText,
      senderId: "",
      createdAt: now,
      type: "system",
      systemAction: "booking_created",
      visibleTo: [checkout.renterId, asset.ownerId].filter(Boolean),
    });
    transaction.set(renterUserChatRootRef, { isOnline: true }, { merge: true });
    transaction.set(ownerUserChatRootRef, { isOnline: true }, { merge: true });
    transaction.set(renterUserChatRef, { ...chatPayload, otherParticipantId: asset.ownerId });
    transaction.set(ownerUserChatRef, { ...chatPayload, otherParticipantId: checkout.renterId });
    transaction.set(
      ownerAssetMirrorRef,
      {
        pendingBookingCount: pendingBookingCountIncrementValue({
          fieldValue: admin.firestore.FieldValue,
          currentValue: ownerAssetMirrorSnap.data()?.pendingBookingCount,
          delta: 0,
        }),
      },
      { merge: true },
    );
    transaction.set(
      assetRef,
      {
        engagement: {
          bookingRequestCount: admin.firestore?.FieldValue?.increment(1) || FieldValue.increment(1),
          lastEngagedAt: now,
        },
        popularityScore: admin.firestore?.FieldValue?.increment(5) || FieldValue.increment(5),
        recommendationScore: admin.firestore?.FieldValue?.increment(2) || FieldValue.increment(2),
      },
      { merge: true },
    );
    transaction.set(
      checkoutRef,
      {
        status: CHECKOUT_STATUS.booked,
        paymentStatus: attrs.status,
        bookingId: bookingRef.id,
        chatId: chatRef.id,
        rootBookingId: bookingRef.id,
        bookedAt: now,
        confirmedBy: source,
        lastSyncedAt: now,
      },
      { merge: true },
    );
    for (const lockRef of dateLockRefs) {
      transaction.set(
        lockRef,
        { checkoutId, bookingId: bookingRef.id, status: CHECKOUT_STATUS.booked, expiresAtMs: null, updatedAt: now },
        { merge: true },
      );
    }
    const event = {
      type: "paid-confirmed",
      actorId: checkout.renterId,
      fromStatus: null,
      toStatus: BOOKING_STATUS.confirmed,
      createdAt: now,
      checkoutId,
      paymentIntentId: checkout.paymentIntentId,
    };
    transaction.set(rootBookingRef.collection("events").doc("paid-confirmed"), event, { merge: true });
    transaction.set(bookingRef.collection("events").doc("paid-confirmed"), event, { merge: true });
    transaction.set(assetBookingRef.collection("events").doc("paid-confirmed"), event, { merge: true });
    updateRecommendationProfile(transaction, db, {
      uid: checkout.renterId,
      asset: { ...assetSnapshot, ownerId: asset.ownerId },
      weight: 5,
      signalType: "bookingRequest",
    });

    confirmResult = {
      alreadyBooked: false,
      booking: bookingPayload,
      bookingId: bookingRef.id,
      chatId: chatRef.id,
      assetId: checkout.assetId,
      renterId: checkout.renterId,
      ownerId: asset.ownerId,
      assetTitle: asset.title,
      assetImageUrl: firstListingImageUrl(assetSnapshot),
      startDate: bookingRange.startDate,
      endDate: bookingRange.endDate,
      tokens: tokenData.rawTokens,
      expiries: tokenData.expiries,
    };
  });

  if (confirmResult?.bookingId && !confirmResult.alreadyBooked) {
    await sendNotificationToUser({
      uid: confirmResult.ownerId,
      title: "New Booking",
      body: formatNewBookingNotificationBody(confirmResult),
      imageUrl: confirmResult.assetImageUrl,
      push: false,
      data: {
        type: "booking",
        target: "bookingDetails",
        chatId: confirmResult.chatId,
        bookingId: confirmResult.bookingId,
        assetId: confirmResult.assetId,
        senderId: confirmResult.renterId,
      },
    }).catch((error) => {
      console.warn(`[createConfirmedBookingFromCheckout] Failed to send owner notification: ${error.message}`);
    });
    await sendPaymentReceiptEmail({
      booking: confirmResult.booking,
      renterId: confirmResult.renterId,
    });
  }

  return confirmResult;
}

function formatNewBookingNotificationBody({ assetTitle, startDate, endDate }) {
  const subject = formatBookingPurpose({ assetTitle, startDate }, "was booked.", "A booking");
  const formattedEnd = formatBookingStartDate(endDate);
  return formattedEnd ? `${subject} Return date: ${formattedEnd}.` : subject;
}

async function syncPaymentSession({ auth, checkoutId, source = "client-sync" }) {
  if (!auth) throwAndLogHttpsError("permission-denied", "User must be authenticated");
  if (!checkoutId) throwAndLogHttpsError("invalid-argument", "Missing checkoutId");

  const checkoutSnap = await paymentCheckoutRef(checkoutId).get();
  if (!checkoutSnap.exists) throwAndLogHttpsError("not-found", "Payment checkout not found");
  const checkout = checkoutSnap.data();
  if (checkout.renterId !== auth.uid) {
    throwAndLogHttpsError("permission-denied", "Checkout does not belong to this user");
  }

  try {
    const paymentIntent = await retrievePaymentIntent(checkout.paymentIntentId);
    return syncCheckoutFromPaymentIntent({ checkoutId, paymentIntent, source });
  } catch (error) {
    const normalized = normalizePayMongoError(error);
    throwAndLogHttpsError("internal", `Unable to sync payment: ${normalized.message}`, normalized);
  }
}

async function syncCheckoutFromPaymentIntent({ checkoutId, paymentIntent, source }) {
  const attrs = paymentIntentAttributes(paymentIntent);
  const checkoutRef = paymentCheckoutRef(checkoutId);
  const checkoutSnap = await checkoutRef.get();
  const checkout = checkoutSnap.exists ? { id: checkoutSnap.id, ...checkoutSnap.data() } : null;

  if (attrs.status === "succeeded") {
    if (checkout?.checkoutType === CHECKOUT_TYPE.outstandingDamage) {
      return markOutstandingDamageCheckoutPaid({ checkout, paymentIntent, source });
    }

    const subscriptionResult = await refreshCheckoutSubscriptions({ checkout });
    if (!subscriptionResult.ready) {
      await checkoutRef.set(
        {
          status: CHECKOUT_STATUS.subscriptionPending,
          paymentStatus: CHECKOUT_STATUS.subscriptionPending,
          billingPlan: subscriptionResult.billingPlan,
          nextAction: subscriptionResult.nextAction || null,
          lastSyncedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
          updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        },
        { merge: true },
      );
      await writeSubscriptionMappings({ checkout, billingPlan: subscriptionResult.billingPlan });
      return {
        success: true,
        status: CHECKOUT_STATUS.subscriptionPending,
        paymentStatus: CHECKOUT_STATUS.subscriptionPending,
        nextAction: subscriptionResult.nextAction || null,
        bookingId: null,
        chatId: null,
      };
    }

    if (subscriptionResult.billingPlan) {
      await checkoutRef.set(
        {
          billingPlan: subscriptionResult.billingPlan,
          updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        },
        { merge: true },
      );
      await writeSubscriptionMappings({ checkout, billingPlan: subscriptionResult.billingPlan });
    }

    const result = await createConfirmedBookingFromCheckout({ checkoutId, paymentIntent, source });
    return {
      success: true,
      status: CHECKOUT_STATUS.booked,
      paymentStatus: attrs.status,
      bookingId: result?.bookingId || null,
      chatId: result?.chatId || null,
      alreadyBooked: result?.alreadyBooked === true,
    };
  }

  const nextCheckoutStatus =
    attrs.status === "awaiting_payment_method" ? CHECKOUT_STATUS.failed : CHECKOUT_STATUS.processing;
  await checkoutRef.set(
    {
      status: nextCheckoutStatus,
      paymentStatus: attrs.status || null,
      lastPaymentError: attrs.last_payment_error || null,
      lastSyncedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    },
    { merge: true },
  );

  if (nextCheckoutStatus === CHECKOUT_STATUS.failed && checkout) {
    await cancelCheckoutSubscriptions({ checkout, reason: "other" });
    await releaseCheckoutDateLocks({ checkout, status: CHECKOUT_STATUS.failed });
  }

  return {
    success: true,
    status: attrs.status || "unknown",
    paymentStatus: attrs.status || null,
    nextAction: attrs.next_action || null,
    lastPaymentError: attrs.last_payment_error || null,
  };
}

function isClientCancellableCheckoutStatus(status) {
  return [CHECKOUT_STATUS.initialized, CHECKOUT_STATUS.processing, CHECKOUT_STATUS.subscriptionPending].includes(status);
}

async function markCheckoutTerminal({ checkout, reason, status, cancelledBy }) {
  await cancelCheckoutSubscriptions({ checkout, reason: "other" });
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  await paymentCheckoutRef(checkout.id).set(
    {
      status,
      paymentStatus: status,
      lastPaymentError: reason || null,
      cancelledBy: cancelledBy || null,
      cancelledAt: cancelledBy ? now : null,
      updatedAt: now,
    },
    { merge: true },
  );
  await releaseCheckoutDateLocks({ checkout, status });
  if ([CHECKOUT_STATUS.failed, CHECKOUT_STATUS.expired, CHECKOUT_STATUS.cancelled].includes(status)) {
    await sendPaymentFailedEmail({
      booking: {
        id: checkout.bookingId || checkout.id,
        asset: checkout.asset || null,
        assetTitle: checkout.assetTitle || checkout.asset?.title || null,
        startDate: checkout.startDate || checkout.startDateMs || null,
      },
      checkoutId: checkout.id,
      renterId: checkout.renterId,
    });
  }
}

function normalizeClientCancelReason(reason) {
  const text = typeof reason === "string" ? reason.trim().slice(0, 240) : "";
  return text || "Payment was cancelled";
}

function terminalRecoveryResult(checkout) {
  return {
    success: true,
    hasPendingCheckout: false,
    status: checkout.status || null,
    paymentStatus: checkout.paymentStatus || null,
    bookingId: checkout.bookingId || null,
    chatId: checkout.chatId || null,
  };
}

async function buildPendingRecoveryPayload({ checkout, syncResult }) {
  return {
    success: true,
    hasPendingCheckout: true,
    status: syncResult.status || checkout.status || CHECKOUT_STATUS.processing,
    paymentStatus: syncResult.paymentStatus || checkout.paymentStatus || null,
    checkout: {
      checkoutId: checkout.id,
      assetId: checkout.assetId || null,
      startDateMs: checkout.startDateMs || null,
      endDateMs: checkout.endDateMs || null,
      totalPrice: checkout.totalPrice || null,
      checkoutLockExpiresAtMs: checkout.checkoutLockExpiresAtMs || null,
      paymentStatus: checkout.paymentStatus || null,
    },
    nextAction: syncResult.nextAction || null,
    lastPaymentError: syncResult.lastPaymentError || null,
  };
}

function toSavedPaymentMethod(item) {
  const attrs = item?.attributes || {};
  return {
    id: item?.id || null,
    paymentMethodId: attrs.payment_method_id || null,
    type: attrs.payment_method_type || attrs.type || "card",
    sessionType: attrs.session_type || null,
    createdAt: attrs.created_at || null,
    details: attrs.details || {},
    card: attrs.card || {},
    brand: attrs.details?.brand || attrs.card?.brand || null,
    last4: attrs.details?.last4 || attrs.card?.last4 || null,
    expMonth: attrs.details?.exp_month || attrs.card?.exp_month || null,
    expYear: attrs.details?.exp_year || attrs.card?.exp_year || null,
  };
}

function getPayMongoEventId(payload) {
  return payload?.data?.id || payload?.id || null;
}

function getPayMongoEventType(payload) {
  return payload?.data?.attributes?.type || payload?.type || null;
}

function getPayMongoPaymentIntentId(payload) {
  const attrs = payload?.data?.attributes?.data?.attributes || payload?.data?.attributes || {};
  return attrs.payment_intent_id || findPaymentIntentId(attrs) || null;
}

function getPayMongoSubscriptionId(payload) {
  const attrs = payload?.data?.attributes?.data || payload?.data?.attributes || payload?.data || payload || {};
  return findSubscriptionId(attrs) || null;
}

function findPaymentIntentId(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);

  if (typeof value.payment_intent === "string") return value.payment_intent;
  if (typeof value.payment_intent_id === "string") return value.payment_intent_id;
  if (value.payment_intent && typeof value.payment_intent === "object" && typeof value.payment_intent.id === "string") {
    return value.payment_intent.id;
  }
  if (
    value.payment_intent &&
    typeof value.payment_intent === "object" &&
    typeof value.payment_intent.data?.id === "string"
  ) {
    return value.payment_intent.data.id;
  }

  for (const child of Object.values(value)) {
    const found = findPaymentIntentId(child, seen);
    if (found) return found;
  }
  return null;
}

function findSubscriptionId(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);

  if (value.type === "subscription" && typeof value.id === "string") return value.id;
  if (typeof value.subscription_id === "string") return value.subscription_id;
  if (typeof value.subscription === "string") return value.subscription;
  if (value.subscription && typeof value.subscription === "object" && typeof value.subscription.id === "string") {
    return value.subscription.id;
  }
  if (
    value.subscription &&
    typeof value.subscription === "object" &&
    typeof value.subscription.data?.id === "string"
  ) {
    return value.subscription.data.id;
  }

  for (const child of Object.values(value)) {
    const found = findSubscriptionId(child, seen);
    if (found) return found;
  }
  return null;
}

async function handlePayMongoEvent(payload) {
  const type = getPayMongoEventType(payload);
  const paymentIntentId = getPayMongoPaymentIntentId(payload);
  const db = admin.firestore();

  if (paymentIntentId) {
    const checkoutSnap = await db
      .collection("paymentCheckouts")
      .where("paymentIntentId", "==", paymentIntentId)
      .limit(1)
      .get();
    if (!checkoutSnap.empty) {
      const checkoutId = checkoutSnap.docs[0].id;

      if (type === "payment.paid") {
        const paymentIntent = await retrievePaymentIntent(paymentIntentId);
        await syncCheckoutFromPaymentIntent({ checkoutId, paymentIntent, source: "webhook" });
        return;
      }

      if (type === "payment.failed" || type === "qrph.expired") {
        const checkout = { id: checkoutId, ...checkoutSnap.docs[0].data() };
        const status = type === "qrph.expired" ? CHECKOUT_STATUS.expired : CHECKOUT_STATUS.failed;
        await cancelCheckoutSubscriptions({ checkout, reason: "other" });
        await paymentCheckoutRef(checkoutId).set(
          {
            status,
            paymentStatus: type,
            lastWebhookEvent: type,
            updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
          },
          { merge: true },
        );
        await releaseCheckoutDateLocks({ checkout, status });
        await sendPaymentFailedEmail({
          booking: {
            id: checkout.bookingId || checkout.id,
            asset: checkout.asset || null,
            assetTitle: checkout.assetTitle || checkout.asset?.title || null,
            startDate: checkout.startDate || checkout.startDateMs || null,
          },
          checkoutId: checkout.id,
          renterId: checkout.renterId,
        });
      }
    }
  }

  const subscriptionIdValue = getPayMongoSubscriptionId(payload);
  if (!subscriptionIdValue) return;
  const mappingSnap = await subscriptionMappingRef(subscriptionIdValue)?.get();
  if (!mappingSnap?.exists) return;
  const mapping = mappingSnap.data() || {};
  const checkoutId = mapping.checkoutId;
  if (!checkoutId) return;
  const checkoutSnap = await paymentCheckoutRef(checkoutId).get();
  if (!checkoutSnap.exists) return;
  const checkout = { id: checkoutSnap.id, ...checkoutSnap.data() };
  const subscription = await retrieveSubscription(subscriptionIdValue);
  const schedules = (checkout.billingPlan?.subscriptionSchedules || []).map((schedule) =>
    schedule.paymongoSubscriptionId === subscriptionIdValue
      ? mergeSubscriptionScheduleFromProvider(schedule, subscription)
      : schedule,
  );
  const billingPlan = {
    ...(checkout.billingPlan || {}),
    status: schedules.some((schedule) => schedule.status === "payment_issue") ? "payment_issue" : "scheduled",
    subscriptionSchedules: schedules,
    chunks: updateChunksForSubscriptionSchedules(checkout.billingPlan?.chunks || [], schedules),
    updatedAt: new Date(),
  };
  await paymentCheckoutRef(checkoutId).set(
    {
      billingPlan,
      lastWebhookEvent: type || null,
      updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    },
    { merge: true },
  );
  await writeSubscriptionMappings({ checkout, billingPlan });
  if (checkout.bookingId) {
    const bookingSnap = await db.collection("bookings").doc(checkout.bookingId).get();
    if (bookingSnap.exists) {
      const booking = { id: bookingSnap.id, ...bookingSnap.data(), billingPlan, lastUpdated: new Date() };
      await db.runTransaction(async (transaction) => {
        writeBookingAndMirrors(transaction, booking);
      });
    }
  }
}

function normalizePayoutDestination(input) {
  const destinationType = input?.destinationType === "ewallet" ? "ewallet" : "bank";
  const supportedProviders = Array.isArray(input?.supportedProviders)
    ? input.supportedProviders
        .map((provider) => String(provider).trim())
        .filter((provider) => ["instapay", "pesonet"].includes(provider))
    : [];
  const provider =
    input?.provider === "pesonet" && (supportedProviders.length === 0 || supportedProviders.includes("pesonet"))
      ? "pesonet"
      : "instapay";
  const bankId = String(input?.bankId || "").trim();
  const bankCode = String(input?.bankCode || "").trim();
  const bankName = String(input?.bankName || "").trim();
  const accountName = String(input?.accountName || "").trim();
  const accountNumber = String(input?.accountNumber || "").trim();
  if (!bankId || !bankName || !accountName || !accountNumber) throw new Error("Missing payout destination details");
  if (accountName.length > 120 || accountNumber.length > 40) throw new Error("Payout destination details are too long");
  return {
    destinationType,
    provider,
    bankId,
    bankCode,
    bankName,
    accountName,
    accountNumber,
    supportedProviders,
    updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
  };
}

function buildProviderPayoutInstitutionLists({ instapayPayload, pesonetPayload, destinationType }) {
  const instapayInstitutions = normalizeInstitutionPayload(instapayPayload, "instapay")
    .filter((institution) => institution.destinationType === destinationType)
    .sort(sortInstitutionByName);
  const pesonetInstitutions = normalizeInstitutionPayload(pesonetPayload, "pesonet")
    .filter((institution) => institution.destinationType === destinationType)
    .sort(sortInstitutionByName);
  const mergedByKey = new Map();
  for (const institution of [...instapayInstitutions, ...pesonetInstitutions]) {
    const key = institution.id || institution.code || institution.name.toLowerCase();
    const existing = mergedByKey.get(key);
    if (existing) {
      existing.supportedProviders = Array.from(
        new Set([...existing.supportedProviders, ...institution.supportedProviders]),
      );
      continue;
    }
    mergedByKey.set(key, { ...institution, supportedProviders: [...institution.supportedProviders] });
  }
  return {
    institutions: Array.from(mergedByKey.values()).sort(sortInstitutionByName),
    instapayInstitutions,
    pesonetInstitutions,
  };
}

function normalizeInstitutionPayload(payload, provider) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data
    .map((item) => {
      const attributes = item?.attributes || {};
      const name = String(
        attributes.name || attributes.bank_name || attributes.institution_name || item?.name || "",
      ).trim();
      const code = String(
        attributes.code || attributes.bank_code || attributes.bic || attributes.swift_code || item?.code || "",
      ).trim();
      const id = String(attributes.id || attributes.bank_id || item?.id || code || name).trim();
      if (!name || !id) return null;
      return { id, code, name, destinationType: classifyInstitution(attributes, name), supportedProviders: [provider] };
    })
    .filter(Boolean);
}

function classifyInstitution(attributes, name) {
  const explicitType = String(
    attributes.destination_type || attributes.destinationType || attributes.category || attributes.type || "",
  ).toLowerCase();
  if (explicitType.includes("wallet") || explicitType.includes("ewallet")) return "ewallet";
  if (explicitType.includes("bank")) return "bank";
  const normalizedName = name.toLowerCase();
  const ewalletKeywords = [
    "gcash",
    "g-xchange",
    "maya",
    "paymaya",
    "grabpay",
    "shopeepay",
    "coins",
    "star pay",
    "starpay",
    "tayo cash",
    "palawanpay",
  ];
  return ewalletKeywords.some((keyword) => normalizedName.includes(keyword)) ? "ewallet" : "bank";
}

function sortInstitutionByName(a, b) {
  return a.name.localeCompare(b.name);
}

async function markOutstandingDamageRequired({
  booking,
  actorId,
  approvedAmount,
  depositCovered,
  outstandingAmount,
  adminNotes,
}) {
  const db = admin.firestore();
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  const updatedBooking = {
    ...booking,
    depositFlow: {
      ...(booking.depositFlow || {}),
      status: DEPOSIT_FLOW_STATUS.outstandingPaymentPending,
      updatedAt: now,
    },
    disputeFlow: {
      ...(booking.disputeFlow || {}),
      status: DISPUTE_STATUS.outstandingPaymentPending,
      approvedAmount,
      depositCoveredAmount: depositCovered,
      outstandingAmount,
      adminNotes: normalizeOptionalText(adminNotes, 1000),
      settledBy: actorId,
      settledAt: now,
      updatedAt: now,
    },
    lastUpdated: now,
  };
  await db.runTransaction(async (tx) => {
    writeBookingAndMirrors(tx, updatedBooking);
    writeSystemMessage(tx, {
      booking: updatedBooking,
      messageText: "Lend Support set an outstanding damage balance for this booking.",
      messageName: "outstanding-damage-required",
      chatStatus: CHAT_STATUS.active,
    });
  });
  return { success: true, status: DISPUTE_STATUS.outstandingPaymentPending, outstandingAmount };
}

async function markOutstandingDamageCheckoutPaid({ checkout, paymentIntent, source }) {
  const db = admin.firestore();
  const attrs = paymentIntentAttributes(paymentIntent);
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  const checkoutRef = paymentCheckoutRef(checkout.id);
  const bookingRef = db.collection("bookings").doc(checkout.bookingId);
  const requestRef = db.collection("damageBalancePaymentRequests").doc(checkout.damagePaymentRequestId);
  let result = null;
  await db.runTransaction(async (tx) => {
    const [latestCheckoutSnap, bookingSnap, requestSnap] = await Promise.all([
      tx.get(checkoutRef),
      tx.get(bookingRef),
      tx.get(requestRef),
    ]);
    const latestCheckout = latestCheckoutSnap.exists
      ? { id: latestCheckoutSnap.id, ...latestCheckoutSnap.data() }
      : checkout;
    if (latestCheckout.status === CHECKOUT_STATUS.paid) {
      result = {
        success: true,
        status: CHECKOUT_STATUS.paid,
        paymentStatus: attrs.status,
        bookingId: latestCheckout.bookingId,
        chatId: latestCheckout.chatId,
        alreadyPaid: true,
      };
      return;
    }
    if (!bookingSnap.exists || !requestSnap.exists)
      throwAndLogHttpsError("not-found", "Damage payment context not found");
    const booking = bookingSnap.data();
    const paymentRequest = requestSnap.data();
    const amount = Number(latestCheckout.amount || paymentRequest.amount || 0);
    const paymentRecord = {
      requestId: latestCheckout.damagePaymentRequestId,
      checkoutId: latestCheckout.id,
      amount,
      currency: latestCheckout.currency || paymentRequest.currency || "PHP",
      renterProcessingFee: Number(latestCheckout.priceBreakdown?.renterProcessingFee || 0),
      paymentAmount: Number(latestCheckout.paymentAmount || 0),
      paymentIntentId: latestCheckout.paymentIntentId || null,
      paymentStatus: attrs.status || null,
      paidAt: now,
      source: source || null,
    };
    const updatedBooking = buildOutstandingDamagePaidBookingState({
      booking,
      amount,
      paymentRecord,
      now,
    });
    writeBookingAndMirrors(tx, updatedBooking);
    tx.set(
      requestRef,
      {
        ...paymentRequest,
        status: "paid",
        checkoutId: latestCheckout.id,
        paymentIntentId: latestCheckout.paymentIntentId || null,
        paidAt: now,
        updatedAt: now,
      },
      { merge: true },
    );
    tx.set(
      checkoutRef,
      { status: CHECKOUT_STATUS.paid, paymentStatus: attrs.status, paidAt: now, lastSyncedAt: now },
      { merge: true },
    );
    const requestChatId =
      latestCheckout.chatId || paymentRequest.chatId || booking?.disputeFlow?.renterSupportChatId || booking.chatId;
    if (requestChatId) {
      deleteOutstandingDamagePaymentRequestMessage(tx, { db, chatId: requestChatId, bookingId: booking.id });
    }
    if (requestChatId && booking?.disputeFlow?.renterSupportChatId === requestChatId) {
      writeSupportSystemMessage(tx, {
        db,
        chatId: requestChatId,
        participantUserId: getBookingActors(booking).renterId,
        messageId: getLifecycleMessageId("outstanding-damage-payment-paid", booking.id),
        messageText: "Outstanding damage payment was paid.",
        chatStatus: CHAT_STATUS.active,
        systemAction: "damage_balance_payment_paid",
        extra: { paymentRequestId: latestCheckout.damagePaymentRequestId, paymentStatus: "paid", amount },
        now,
      });
    } else {
      writeSystemMessage(tx, {
        booking: updatedBooking,
        chatId: requestChatId,
        messageText: "Outstanding damage payment was paid.",
        messageName: "outstanding-damage-payment-paid",
        chatStatus: CHAT_STATUS.active,
        systemAction: "damage_balance_payment_paid",
        extra: { paymentRequestId: latestCheckout.damagePaymentRequestId, paymentStatus: "paid", amount },
      });
    }
    result = {
      success: true,
      status: CHECKOUT_STATUS.paid,
      paymentStatus: attrs.status,
      bookingId: booking.id,
      chatId: requestChatId,
    };
  });
  return result;
}

function buildOutstandingDamagePaidBookingState({ booking, amount, paymentRecord, now }) {
  const existingSettlement = booking.settlement || {};
  const existingOwnerBalancePayoutStatus = existingSettlement.ownerDamageBalancePayoutStatus || null;
  const ownerDamageBalancePayoutStatus = ["processing", "succeeded"].includes(existingOwnerBalancePayoutStatus)
    ? existingOwnerBalancePayoutStatus
    : null;
  const existingOutstandingAmount = Number(existingSettlement.outstandingDamageAmount || booking.disputeFlow?.outstandingAmount || 0);
  const outstandingDamageAmount = roundCurrency(existingOutstandingAmount > 0 ? existingOutstandingAmount : amount);
  return {
    ...booking,
    depositFlow: {
      ...(booking.depositFlow || {}),
      status: DEPOSIT_FLOW_STATUS.outstandingPaymentPending,
      updatedAt: now,
    },
    disputeFlow: {
      ...(booking.disputeFlow || {}),
      status: DISPUTE_STATUS.outstandingPaid,
      outstandingPaymentStatus: "paid",
      paidOutstandingAmount: amount,
      outstandingPayment: paymentRecord,
      updatedAt: now,
    },
    settlement: {
      ...existingSettlement,
      status: DISPUTE_STATUS.outstandingPaid,
      damageBalancePaymentStatus: "paid",
      damageBalanceRequestedAmount: amount,
      outstandingDamageAmount,
      ownerDamageBalancePayoutStatus,
      updatedAt: now,
    },
    lastUpdated: now,
  };
}

function buildFinalizedBookingSettlement({
  booking,
  actorId,
  decision,
  approvedDeductionAmount,
  depositCoveredAmount,
  depositReturnAmount,
  paidOutstandingAmount,
  adminNotes,
  now,
}) {
  const {
    ownerPayoutGrossAmount: finalOwnerPayoutGrossAmount,
    ownerPayoutTransferProviderFee: finalOwnerPayoutTransferProviderFee,
    ownerPayoutTransferMarkupFee: finalOwnerPayoutTransferMarkupFee,
    ownerPayoutTransferFee: finalOwnerPayoutTransferFee,
    securityDepositCollectionProcessingFee: finalSecurityDepositCollectionProcessingFee,
    renterDepositReturnTransferProviderFee: finalRenterDepositReturnTransferProviderFee,
    renterDepositReturnTransferMarkupFee: finalRenterDepositReturnTransferMarkupFee,
    renterDepositReturnTransferFee: finalRenterDepositReturnTransferFee,
    ownerProcessingFee: finalOwnerProcessingFee,
    ownerPayoutAmount: finalOwnerPayoutAmount,
  } = buildFinalOwnerPayoutBreakdown({
    booking,
    depositCoveredAmount,
    paidOutstandingAmount,
    depositReturnAmount,
  });
  const hasDeposit = getDepositAmount(booking) > 0;
  const outstandingDamageAmount = roundCurrency(Math.max(Number(approvedDeductionAmount || 0) - Number(depositCoveredAmount || 0), 0));
  const resolvedDamageRequest =
    booking.damageDeductionRequest || booking.disputeFlow
      ? {
          ...(booking.damageDeductionRequest || {}),
          status: DISPUTE_STATUS.resolved,
          approvedAmount: approvedDeductionAmount,
          adminNotes: adminNotes || booking.damageDeductionRequest?.adminNotes || booking.disputeFlow?.adminNotes || null,
          renterResponse: booking.damageDeductionRequest?.renterResponse || booking.disputeFlow?.renterResponse || null,
          updatedAt: now,
        }
      : booking.damageDeductionRequest || null;
  const resolvedSettlement = {
    ...(booking.settlement || {}),
    status: BOOKING_STATUS.completed,
    supportStatus: "resolved",
    approvedDamageDeductionAmount: approvedDeductionAmount,
    depositCoveredDamageAmount: depositCoveredAmount,
    outstandingDamageAmount,
    depositReturnAmount,
    ownerPayoutAmount: finalOwnerPayoutAmount,
    renterResponse: booking.disputeFlow?.renterResponse || booking.damageDeductionRequest?.renterResponse || null,
    damageBalancePaymentStatus: Number(paidOutstandingAmount || 0) > 0 ? "paid" : null,
    damageBalancePaymentRequestId: Number(paidOutstandingAmount || 0) > 0 ? booking.disputeFlow?.outstandingPaymentRequestId || null : null,
    damageBalanceRequestedAmount: Number(paidOutstandingAmount || 0) > 0 ? roundCurrency(Number(paidOutstandingAmount || 0)) : null,
    ownerDamageBalancePayoutStatus: Number(paidOutstandingAmount || 0) > 0 ? PAYOUT_STATUS.processing : null,
    updatedAt: now,
  };
  const updatedBooking = {
    ...booking,
    status: BOOKING_STATUS.completed,
    damageDeductionRequest: resolvedDamageRequest,
    settlement: resolvedSettlement,
    depositFlow: {
      ...(booking.depositFlow || {}),
      status: !hasDeposit
        ? DEPOSIT_FLOW_STATUS.none
        : depositCoveredAmount > 0 && depositReturnAmount > 0
          ? DEPOSIT_FLOW_STATUS.partiallyReturned
          : depositCoveredAmount > 0
            ? DEPOSIT_FLOW_STATUS.deducted
            : DEPOSIT_FLOW_STATUS.returnProcessing,
      approvedDeductionAmount,
      depositCoveredAmount,
      depositReturnAmount,
      completedAt: now,
      updatedAt: now,
    },
    disputeFlow: booking.disputeFlow
      ? {
          ...booking.disputeFlow,
          status: DISPUTE_STATUS.resolved,
          supportStatus: "resolved",
          approvedAmount: approvedDeductionAmount,
          depositCoveredAmount,
          outstandingAmount: outstandingDamageAmount,
          paidOutstandingAmount,
          remainingSecurityDeposit: depositReturnAmount,
          adminNotes: adminNotes || booking.disputeFlow.adminNotes || null,
          resolvedBy: actorId,
          resolvedAt: now,
          updatedAt: now,
        }
      : null,
    payoutFlow: {
      ...(booking.payoutFlow || {}),
      ownerPayoutAmount: finalOwnerPayoutAmount,
      ownerPayoutGrossAmount: finalOwnerPayoutGrossAmount,
      ownerPayoutTransferProviderFee: finalOwnerPayoutTransferProviderFee,
      ownerPayoutTransferMarkupFee: finalOwnerPayoutTransferMarkupFee,
      ownerPayoutTransferFee: finalOwnerPayoutTransferFee,
      securityDepositCollectionProcessingFee: finalSecurityDepositCollectionProcessingFee,
      renterDepositReturnTransferProviderFee: finalRenterDepositReturnTransferProviderFee,
      renterDepositReturnTransferMarkupFee: finalRenterDepositReturnTransferMarkupFee,
      renterDepositReturnTransferFee: finalRenterDepositReturnTransferFee,
      ownerProcessingFee: finalOwnerProcessingFee,
      depositReturnAmount,
      decision,
      completedBy: actorId,
      completedAt: now,
      updatedAt: now,
    },
    lastUpdated: now,
  };
  return {
    finalOwnerPayoutAmount,
    hasDeposit,
    updatedBooking,
  };
}

async function finalizeBookingSettlement({
  booking,
  actorId,
  decision,
  approvedDeductionAmount,
  depositCoveredAmount,
  depositReturnAmount,
  paidOutstandingAmount,
  adminNotes,
}) {
  const db = admin.firestore();
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  const { finalOwnerPayoutAmount, hasDeposit, updatedBooking } = buildFinalizedBookingSettlement({
    booking,
    actorId,
    decision,
    approvedDeductionAmount,
    depositCoveredAmount,
    depositReturnAmount,
    paidOutstandingAmount,
    adminNotes,
    now,
  });
  const outstandingDamageAmount = updatedBooking.settlement.outstandingDamageAmount;
  let finalizedBooking = updatedBooking;
  let ownerPenaltyDeduction = buildOwnerPenaltyDeduction({
    ownerPayoutAmount: finalOwnerPayoutAmount,
    penalties: [],
  });

  await db.runTransaction(async (tx) => {
    const penaltyQuery = ownerCancellationPenaltyQuery(db, updatedBooking);
    const ownerPenaltySnap = penaltyQuery ? await tx.get(penaltyQuery) : null;
    ownerPenaltyDeduction = buildOwnerPenaltyDeduction({
      ownerPayoutAmount: finalOwnerPayoutAmount,
      penalties: ownerPenaltySnap?.docs.map((doc) => ({ id: doc.id, ...doc.data() })) || [],
    });
    finalizedBooking = applyOwnerPenaltyDeductionToBooking({
      booking: updatedBooking,
      deduction: ownerPenaltyDeduction,
      now,
    });

    await archiveExistingDisputeSupportChats({ db, tx, booking: finalizedBooking, now });
    writeBookingAndMirrors(tx, finalizedBooking);
    writeOwnerCancellationPenaltyApplications(tx, {
      db,
      booking: finalizedBooking,
      deduction: ownerPenaltyDeduction,
      now,
    });
    writeCompletionRatingPrompt(tx, { db, booking: finalizedBooking, now });
    writeDepositReturnProcessingMessage(tx, { db, booking: finalizedBooking, depositReturnAmount, now });
  });

  await sendDepositReturnProcessingNotification({
    booking: finalizedBooking,
    depositReturnAmount,
  });

  const ownerResult = await createBookingWalletMovement({
    booking: finalizedBooking,
    movementType: "owner_payout",
    amount: finalizedBooking.payoutFlow?.ownerPayoutAmount,
    destination: await loadOwnerDestination(finalizedBooking),
    targetUserId: finalizedBooking.asset?.owner?.uid,
    description: `Lend owner payout ${booking.id}`,
  });
  let depositResult = { skipped: true, reason: "no_deposit", status: PAYOUT_STATUS.skipped };
  if (hasDeposit && depositReturnAmount > 0) {
    depositResult = await createBookingWalletMovement({
      booking: finalizedBooking,
      movementType: "deposit_return",
      amount: depositReturnAmount,
      destination: await loadDepositReturnDestination(finalizedBooking),
      targetUserId: finalizedBooking.renter?.uid,
      description: `Lend security deposit return ${booking.id}`,
    });
  }
  await updatePayoutFlowAfterMovements({ booking: finalizedBooking, ownerResult, depositResult });
  return {
    success: true,
    status: DISPUTE_STATUS.resolved,
    bookingStatus: BOOKING_STATUS.completed,
    approvedDeductionAmount,
    approvedDamageDeductionAmount: approvedDeductionAmount,
    depositCoveredDamageAmount: depositCoveredAmount,
    outstandingDamageAmount,
    depositReturnAmount,
    ownerPayoutAmount: finalizedBooking.payoutFlow?.ownerPayoutAmount,
    ownerPayoutAmountBeforePenalty: ownerPenaltyDeduction.ownerPayoutAmountBeforePenalty,
    ownerPenaltyDeductionAmount: ownerPenaltyDeduction.ownerPenaltyDeductionAmount,
    ownerPenaltyApplications: ownerPenaltyDeduction.applications,
    ownerPayout: ownerResult,
    depositReturn: depositResult,
  };
}

function buildFinalOwnerPayoutBreakdown({ booking, depositCoveredAmount, paidOutstandingAmount, depositReturnAmount }) {
  const baseOwnerPayoutGrossAmount = getBaseOwnerPayoutGrossAmount(booking);
  const ownerPayoutGrossAmount = roundCurrency(
    baseOwnerPayoutGrossAmount + Number(depositCoveredAmount || 0) + Number(paidOutstandingAmount || 0),
  );
  const transferFeeRules = inferTransferFeeRules(booking);
  const ownerTransferFees =
    ownerPayoutGrossAmount > 0
      ? calculateWalletTransferFeeBreakdown(ownerPayoutGrossAmount, transferFeeRules)
      : emptyWalletTransferFeeBreakdown();
  const ownerPayoutTransferFee = ownerTransferFees.total;
  const securityDepositCollectionProcessingFee = getStoredPositiveAmount(
    booking?.priceBreakdown?.securityDepositCollectionProcessingFee,
  );
  const renterDepositReturnTransferFee =
    Number(depositReturnAmount || 0) > 0
      ? getStoredPositiveAmount(booking?.priceBreakdown?.renterDepositReturnTransferFee)
      : 0;
  const renterDepositReturnTransferProviderFee =
    Number(depositReturnAmount || 0) > 0
      ? getStoredPositiveAmount(
        booking?.priceBreakdown?.renterDepositReturnTransferProviderFee ??
          booking?.priceBreakdown?.renterDepositReturnTransferFee,
      )
      : 0;
  const renterDepositReturnTransferMarkupFee =
    Number(depositReturnAmount || 0) > 0
      ? getStoredPositiveAmount(booking?.priceBreakdown?.renterDepositReturnTransferMarkupFee)
      : 0;
  const ownerProcessingFee = roundCurrency(
    ownerPayoutTransferFee + securityDepositCollectionProcessingFee + renterDepositReturnTransferFee,
  );
  const ownerPayoutAmount = roundCurrency(Math.max(ownerPayoutGrossAmount - ownerProcessingFee, 0));
  return {
    ownerPayoutGrossAmount,
    ownerPayoutTransferProviderFee: ownerTransferFees.provider,
    ownerPayoutTransferMarkupFee: ownerTransferFees.markup,
    ownerPayoutTransferFee,
    securityDepositCollectionProcessingFee,
    renterDepositReturnTransferProviderFee,
    renterDepositReturnTransferMarkupFee,
    renterDepositReturnTransferFee,
    ownerProcessingFee,
    ownerPayoutAmount,
  };
}

function getStoredPositiveAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) && amount > 0 ? roundCurrency(amount) : 0;
}

function ownerCancellationPenaltyQuery(db, booking) {
  const assetId = booking?.asset?.id;
  if (!assetId) return null;

  return db
    .collection("assets")
    .doc(assetId)
    .collection("ownerPenaltyLedger")
    .where("status", "in", OPEN_OWNER_CANCELLATION_PENALTY_STATUSES);
}

function buildOwnerPenaltyDeduction({ ownerPayoutAmount, penalties }) {
  const ownerPayoutAmountBeforePenalty = roundCurrency(Math.max(Number(ownerPayoutAmount || 0), 0));
  let availablePayoutAmount = ownerPayoutAmountBeforePenalty;
  const sortedPenalties = [...(penalties || [])]
    .filter(isOpenOwnerCancellationPenalty)
    .sort(compareOwnerCancellationPenalties);
  const applications = [];

  for (const penalty of sortedPenalties) {
    if (availablePayoutAmount <= 0) break;

    const remainingAmountBefore = roundCurrency(Number(penalty.remainingAmount || 0));
    const appliedAmount = roundCurrency(Math.min(remainingAmountBefore, availablePayoutAmount));
    if (appliedAmount <= 0) continue;

    const remainingAmountAfter = roundCurrency(Math.max(remainingAmountBefore - appliedAmount, 0));
    availablePayoutAmount = roundCurrency(Math.max(availablePayoutAmount - appliedAmount, 0));
    applications.push({
      penaltyId: penalty.id,
      sourceBookingId: penalty.sourceBookingId || penalty.bookingId || penalty.id || null,
      appliedAmount,
      remainingAmountBefore,
      remainingAmountAfter,
      status:
        remainingAmountAfter > 0
          ? OWNER_CANCELLATION_PENALTY_STATUS.partiallyApplied
          : OWNER_CANCELLATION_PENALTY_STATUS.applied,
      currency: penalty.currency || "PHP",
    });
  }

  const ownerPenaltyDeductionAmount = roundCurrency(ownerPayoutAmountBeforePenalty - availablePayoutAmount);
  return {
    ownerPayoutAmountBeforePenalty,
    ownerPenaltyDeductionAmount,
    ownerPayoutAmountAfterPenalty: availablePayoutAmount,
    applications,
  };
}

function isOpenOwnerCancellationPenalty(penalty) {
  const status = penalty?.status || OWNER_CANCELLATION_PENALTY_STATUS.open;
  const remainingAmount = Number(penalty?.remainingAmount || 0);
  return (
    OPEN_OWNER_CANCELLATION_PENALTY_STATUSES.includes(status) &&
    Number.isFinite(remainingAmount) &&
    remainingAmount > 0
  );
}

function compareOwnerCancellationPenalties(a, b) {
  const aTime = ownerPenaltySortTime(a);
  const bTime = ownerPenaltySortTime(b);
  if (aTime !== bTime) return aTime - bTime;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

function ownerPenaltySortTime(penalty) {
  const candidates = [penalty?.approvedAt, penalty?.updatedAt, penalty?.createdAt, penalty?.requestedAt];
  for (const candidate of candidates) {
    const time = timestampMillis(candidate);
    if (Number.isFinite(time)) return time;
  }
  return Number.MAX_SAFE_INTEGER;
}

function timestampMillis(value) {
  if (!value) return Number.NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function applyOwnerPenaltyDeductionToBooking({ booking, deduction, now }) {
  return {
    ...booking,
    payoutFlow: {
      ...(booking.payoutFlow || {}),
      ownerPayoutAmountBeforePenalty: deduction.ownerPayoutAmountBeforePenalty,
      ownerPenaltyDeductionAmount: deduction.ownerPenaltyDeductionAmount,
      ownerPenaltyApplications: deduction.applications,
      ownerPayoutAmount: deduction.ownerPayoutAmountAfterPenalty,
      updatedAt: now,
    },
    lastUpdated: now,
  };
}

function writeOwnerCancellationPenaltyApplications(tx, { db, booking, deduction, now }) {
  const applications = deduction?.applications || [];
  if (applications.length === 0) return;

  const assetId = booking.asset?.id;
  const ownerId = booking.asset?.owner?.uid;
  if (!assetId || !ownerId) return;

  for (const application of applications) {
    const payload = {
      remainingAmount: application.remainingAmountAfter,
      status: application.status,
      lastAppliedAmount: application.appliedAmount,
      lastAppliedBookingId: booking.id,
      lastAppliedAt: now,
      updatedAt: now,
    };
    tx.set(
      db.collection("assets").doc(assetId).collection("ownerPenaltyLedger").doc(application.penaltyId),
      payload,
      { merge: true },
    );
    tx.set(
      db.collection("users").doc(ownerId).collection("ownerPenaltyLedger").doc(application.penaltyId),
      payload,
      { merge: true },
    );
  }
}

function getBaseOwnerPayoutGrossAmount(booking) {
  const priceBreakdown = booking?.priceBreakdown || {};
  const grossCandidates = [priceBreakdown.rentalSubtotal, priceBreakdown.durationAmount, booking?.totalPrice];
  for (const candidate of grossCandidates) {
    const amount = Number(candidate);
    if (Number.isFinite(amount) && amount > 0) return amount;
  }

  const legacyNetAmount = Number(priceBreakdown.ownerPayoutAmount || 0);
  const legacyTransferFee = Number(priceBreakdown.ownerPayoutTransferFee || 0);
  return Math.max(legacyNetAmount + legacyTransferFee, 0);
}

async function archiveExistingDisputeSupportChats({ db, tx, booking, now }) {
  const supportUser = getSupportUserSnapshot();
  const { ownerId, renterId } = getBookingActors(booking);
  const candidates = [
    { chatId: booking?.disputeFlow?.renterSupportChatId, participantUserId: renterId },
    { chatId: booking?.disputeFlow?.ownerSupportChatId, participantUserId: ownerId },
  ].filter((candidate) => candidate.chatId && candidate.participantUserId);

  if (candidates.length === 0) return;

  const statusUpdate = { status: CHAT_STATUS.archived, updatedAt: now, lastUpdated: now };
  const refs = candidates.flatMap(({ chatId, participantUserId }) => [
    db.collection("chats").doc(chatId),
    db.collection("userChats").doc(participantUserId).collection("chats").doc(chatId),
    db.collection("userChats").doc(supportUser.uid).collection("chats").doc(chatId),
  ]);
  const snapshots = await Promise.all(refs.map((ref) => tx.get(ref)));

  snapshots.forEach((snapshot, index) => {
    if (!snapshot.exists) return;
    tx.set(refs[index], statusUpdate, { merge: true });
  });
}

function writeCompletionRatingPrompt(tx, { db, booking, now }) {
  const { ownerId, renterId } = getBookingActors(booking);
  const chatId = booking?.chatId;
  if (!chatId || !renterId) return;

  const messageText = "Booking completed. Rate your rental experience.";
  writeVisibleSystemMessage(tx, {
    db,
    booking,
    chatId,
    messageText,
    messageName: "rating-request",
    type: "rating",
    systemAction: "rating-request",
    visibleTo: [renterId],
    rootPreviewText: "Booking completed.",
    rootStatus: CHAT_STATUS.active,
    chatStatusByUser: {
      [renterId]: CHAT_STATUS.active,
      ...(ownerId ? { [ownerId]: CHAT_STATUS.archived } : {}),
    },
    extra: { bookingId: booking.id, chatId },
    now,
  });
}

function writeDepositReturnProcessingMessage(tx, { db, booking, depositReturnAmount, now }) {
  const notice = buildDepositReturnProcessingNotice({ booking, depositReturnAmount });
  if (!notice) return;
  const { type: _notificationType, ...messageExtra } = notice.data;

  writeVisibleSystemMessage(tx, {
    db,
    booking,
    chatId: notice.chatId,
    messageText: notice.body,
    messageName: "deposit_return_processing",
    type: "system",
    systemAction: "deposit_return_processing",
    visibleTo: [notice.renterId],
    rootPreviewText: "New booking update.",
    extra: messageExtra,
    now,
  });
}

async function sendDepositReturnProcessingNotification({ booking, depositReturnAmount }) {
  const notification = buildDepositReturnProcessingNotificationRequest({ booking, depositReturnAmount });
  if (!notification) return null;

  return sendNotificationToUser(notification).catch((error) => {
    console.warn(`[finalizeBookingSettlement] Failed to send deposit return notification: ${error.message}`);
    return null;
  });
}

function buildDepositReturnProcessingNotificationRequest({ booking, depositReturnAmount }) {
  const notice = buildDepositReturnProcessingNotice({ booking, depositReturnAmount });
  if (!notice) return null;

  return {
    uid: notice.renterId,
    title: notice.title,
    body: notice.body,
    push: false,
    data: notice.data,
  };
}

function buildDepositReturnProcessingNotice({ booking, depositReturnAmount }) {
  const amount = roundCurrency(Number(depositReturnAmount || 0));
  const { renterId } = getBookingActors(booking);
  const chatId = booking?.chatId;
  if (getDepositAmount(booking) <= 0 || amount <= 0 || !renterId || !chatId) return null;

  const currency = bookingCurrency(booking);
  const formattedAmount = formatCurrencyAmount(currency, amount);
  const body = `Your security deposit return of ${formattedAmount} is being processed. Expect it on or before ${DEPOSIT_RETURN_PROCESSING_DAYS_TEXT}.`;
  return {
    renterId,
    chatId,
    title: "Security deposit return processing",
    body,
    data: {
      type: "deposit_return_processing",
      bookingId: booking.id,
      chatId,
      assetId: booking.asset?.id || null,
      imageUrl: firstListingImageUrl(booking.asset),
      amount,
      currency,
    },
  };
}

async function sendOwnerPayoutProcessingNotice({ booking, movementType, amount, currency }) {
  const db = admin.firestore();
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  const notice = buildOwnerPayoutProcessingNotice({ booking, movementType, amount, currency });
  if (!notice) return null;

  await db.runTransaction(async (tx) => {
    writeOwnerPayoutProcessingMessage(tx, { db, booking, notice, now });
  });

  return sendNotificationToUser(buildOwnerPayoutProcessingNotificationRequest({ notice })).catch((error) => {
    console.warn(`[createBookingWalletMovement] Failed to send owner payout notification: ${error.message}`);
    return null;
  }).finally(() =>
    sendPayoutEmail({
      booking,
      ownerId: notice.ownerId,
      payoutStatus: "processing",
    }),
  );
}

function writeOwnerPayoutProcessingMessage(tx, { db, booking, notice, now }) {
  if (!notice) return;
  const { type: _notificationType, ...messageExtra } = notice.data;

  writeVisibleSystemMessage(tx, {
    db,
    booking,
    chatId: notice.chatId,
    messageText: notice.body,
    messageName: `owner_payout_processing_${notice.movementType}`,
    type: "system",
    systemAction: "owner_payout_processing",
    visibleTo: [notice.ownerId],
    rootPreviewText: "New booking update.",
    extra: messageExtra,
    now,
  });
}

function buildOwnerPayoutProcessingNotificationRequest({ notice }) {
  if (!notice) return null;
  return {
    uid: notice.ownerId,
    title: notice.title,
    body: notice.body,
    push: false,
    data: notice.data,
  };
}

function buildOwnerPayoutProcessingNotice({ booking, movementType, amount, currency }) {
  const normalizedAmount = roundCurrency(Number(amount || 0));
  const { ownerId } = getBookingActors(booking);
  const chatId = booking?.chatId;
  if (!OWNER_PAYOUT_MOVEMENT_TYPES.has(movementType) || normalizedAmount <= 0 || !ownerId || !chatId) return null;

  const resolvedCurrency = normalizeCurrency(currency || bookingCurrency(booking));
  const formattedAmount = formatCurrencyAmount(resolvedCurrency, normalizedAmount);
  const body = `Your owner payout of ${formattedAmount} is being processed. You will receive it in your account on or before ${DEPOSIT_RETURN_PROCESSING_DAYS_TEXT}.`;
  return {
    ownerId,
    chatId,
    movementType,
    title: "Owner payout processing",
    body,
    data: {
      type: "owner_payout_processing",
      bookingId: booking.id,
      chatId,
      assetId: booking.asset?.id || null,
      imageUrl: firstListingImageUrl(booking.asset),
      amount: normalizedAmount,
      currency: resolvedCurrency,
      movementType,
    },
  };
}

function formatCurrencyAmount(currency, amount) {
  return `${normalizeCurrency(currency)} ${formatExactNumber(amount)}`;
}

function formatExactNumber(value) {
  const amount = roundCurrency(Number(value || 0));
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function inferTransferFeeRules(booking) {
  const legacyRule = booking?.priceBreakdown?.transferFeeRule;
  const providerRule = booking?.priceBreakdown?.transferFeeProviderRule || legacyRule;
  const markupRule = booking?.priceBreakdown?.transferFeeMarkupRule;
  return {
    walletTransferProvider: {
      rateBps: Number(providerRule?.rateBps || 0),
      fixedAmount: Number(providerRule?.fixedAmount || 0),
      calculation: providerRule?.calculation || "fixed_only",
    },
    walletTransferMarkup: {
      rateBps: Number(markupRule?.rateBps || 0),
      fixedAmount: Number(markupRule?.fixedAmount || 0),
      calculation: markupRule?.calculation || "fixed_only",
    },
  };
}

function inferTransferFeeRule(booking) {
  return inferTransferFeeRules(booking).walletTransferProvider;
}

async function updatePayoutFlowAfterMovements({ booking, ownerResult, depositResult }) {
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  const updatedBooking = {
    ...booking,
    payoutFlow: {
      ...(booking.payoutFlow || {}),
      ownerPayoutStatus: ownerResult.status || (ownerResult.skipped ? PAYOUT_STATUS.skipped : PAYOUT_STATUS.processing),
      ownerPayoutError: ownerResult.error || null,
      depositReturnStatus:
        depositResult.status || (depositResult.skipped ? PAYOUT_STATUS.skipped : PAYOUT_STATUS.processing),
      depositReturnError: depositResult.error || null,
      updatedAt: now,
    },
    lastUpdated: now,
  };
  await admin.firestore().runTransaction(async (tx) => writeBookingAndMirrors(tx, updatedBooking));
}

function getDepositAmount(booking) {
  if (booking?.depositFlow?.required === true) return Number(booking.depositFlow.amount || 0);
  return booking?.securityDeposit?.enabled ? Number(booking.securityDeposit.amount || 0) : 0;
}

function assertReturnedAwaitingOwnerAction(booking) {
  if (booking?.status !== BOOKING_STATUS.returned) {
    throwAndLogHttpsError("failed-precondition", "Booking must be returned before settlement");
  }
  const depositStatus = booking?.depositFlow?.status;
  const allowedStatuses = [DEPOSIT_FLOW_STATUS.held, DEPOSIT_FLOW_STATUS.awaitingOwnerAction];
  if (getDepositAmount(booking) <= 0) allowedStatuses.push(DEPOSIT_FLOW_STATUS.none);
  if (depositStatus && !allowedStatuses.includes(depositStatus)) {
    throwAndLogHttpsError("failed-precondition", "Booking is not awaiting owner settlement action");
  }
}

function writeBookingAndMirrors(tx, booking) {
  const { rootBookingRef, assetBookingRef, userBookingRef } = getBookingRefs({
    assetId: booking.asset?.id,
    bookingId: booking.id,
    renterId: booking.renter?.uid,
  });
  tx.set(rootBookingRef, booking, { merge: true });
  tx.set(assetBookingRef, buildBookingMirrorUpdate(booking), { merge: true });
  tx.set(userBookingRef, buildBookingMirrorUpdate(booking), { merge: true });
}

function uniqueUserIds(userIds) {
  return [...new Set((userIds || []).filter(Boolean))];
}

function writeVisibleSystemMessage(
  tx,
  {
    db = admin.firestore(),
    booking,
    chatId,
    messageText,
    messageName,
    chatStatus,
    rootStatus,
    chatStatusByUser = {},
    systemAction,
    type = "system",
    visibleTo,
    rootPreviewText,
    extra = {},
    now = admin.firestore.FieldValue?.serverTimestamp() || new Date(),
  },
) {
  const { ownerId, renterId } = getBookingActors(booking);
  const resolvedChatId = chatId || booking.chatId;
  if (!resolvedChatId) return;

  const participantIds = uniqueUserIds([ownerId, renterId]);
  const messageVisibleTo = uniqueUserIds(visibleTo || participantIds);
  const restricted =
    messageVisibleTo.length !== participantIds.length || !participantIds.every((uid) => messageVisibleTo.includes(uid));
  const messageId = getLifecycleMessageId(messageName, booking.id);
  const chatRef = db.collection("chats").doc(resolvedChatId);
  const messageRef = chatRef.collection("messages").doc(messageId);
  const rootChatUpdate = {
    bookingStatus: booking.status || null,
    lastMessageDate: now,
    lastMessageSenderId: "",
    ...(rootStatus || chatStatus ? { status: rootStatus || chatStatus } : {}),
  };
  const rootLastMessage =
    rootPreviewText !== undefined ? rootPreviewText : restricted ? "New booking update." : messageText;
  if (rootLastMessage !== null) rootChatUpdate.lastMessage = rootLastMessage;

  tx.set(
    messageRef,
    {
      id: messageId,
      text: messageText,
      senderId: "",
      createdAt: now,
      type,
      systemAction: systemAction || messageName,
      ...extra,
      visibleTo: messageVisibleTo,
    },
    { merge: true },
  );
  tx.set(chatRef, rootChatUpdate, { merge: true });

  for (const uid of participantIds) {
    const isVisible = messageVisibleTo.includes(uid);
    const mirrorUpdate = {
      bookingStatus: booking.status || null,
      ...(chatStatusByUser[uid] || (isVisible && chatStatus) ? { status: chatStatusByUser[uid] || chatStatus } : {}),
    };
    if (isVisible) {
      mirrorUpdate.lastMessage = messageText;
      mirrorUpdate.lastMessageDate = now;
      mirrorUpdate.lastMessageSenderId = "";
    }
    if (Object.keys(mirrorUpdate).length <= 1 && mirrorUpdate.bookingStatus == null) continue;
    tx.set(db.collection("userChats").doc(uid).collection("chats").doc(resolvedChatId), mirrorUpdate, { merge: true });
  }
}

function writeSystemMessage(tx, { booking, chatId, messageText, messageName, chatStatus, systemAction, extra = {} }) {
  const { visibleTo, ...messageExtra } = extra || {};
  writeVisibleSystemMessage(tx, {
    booking,
    chatId,
    messageText,
    messageName,
    chatStatus,
    systemAction,
    visibleTo,
    extra: messageExtra,
  });
}

function normalizeRequiredText(value, fieldName, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throwAndLogHttpsError("invalid-argument", `Missing ${fieldName}`);
  return text.slice(0, maxLength);
}

function normalizeOptionalText(value, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : null;
}

function normalizePositiveAmount(value, fieldName) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throwAndLogHttpsError("invalid-argument", `Invalid ${fieldName}`);
  return roundCurrency(amount);
}

function normalizeNonNegativeAmount(value, fieldName) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throwAndLogHttpsError("invalid-argument", `Invalid ${fieldName}`);
  return roundCurrency(amount);
}

function normalizeEvidenceUrls(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((url) => (typeof url === "string" ? url.trim() : ""))
    .filter(Boolean)
    .slice(0, 12);
}

function isSupportReviewReason(reason) {
  const normalized = String(reason || "")
    .trim()
    .toLowerCase();
  return (
    normalized.includes("higher than security deposit") ||
    normalized.includes("total loss") ||
    normalized.includes("total damage")
  );
}

function buildDamageRequestSettlementPlan({ depositAmount, requestedAmount, reason }) {
  const normalizedDepositAmount = Math.max(Number(depositAmount || 0), 0);
  const supportReason = isSupportReviewReason(reason);
  if (supportReason) {
    return {
      amount: null,
      depositAmount: normalizedDepositAmount,
      depositCoveredAmount: 0,
      outstandingAmount: 0,
      needsSupport: true,
    };
  }
  if (normalizedDepositAmount <= 0) {
    throwAndLogHttpsError("failed-precondition", "Damage fees without a security deposit require Lend Support review");
  }
  const amount = normalizePositiveAmount(requestedAmount, "requested deduction amount");
  const outstandingAmount = Math.max(amount - normalizedDepositAmount, 0);
  return {
    amount,
    depositAmount: normalizedDepositAmount,
    depositCoveredAmount: Math.min(amount, normalizedDepositAmount),
    outstandingAmount,
    needsSupport: normalizedDepositAmount <= 0 || outstandingAmount > 0 || supportReason,
  };
}

function buildSupportChatWrite({ db, booking, target, now }) {
  const { ownerId, renterId } = getBookingActors(booking);
  const participantUserId = target === "renter" ? renterId : ownerId;
  const participant = target === "renter" ? booking.renter : booking.asset?.owner;
  const supportUser = getSupportUserSnapshot();
  if ([ownerId, renterId].filter(Boolean).includes(supportUser.uid)) {
    throwAndLogHttpsError("failed-precondition", "Lend Support user cannot be a booking participant");
  }
  const chatRef = db.collection("chats").doc();
  const userChatRootRef = db.collection("userChats").doc(participantUserId);
  const userChatRef = userChatRootRef.collection("chats").doc(chatRef.id);
  const supportChatRootRef = db.collection("userChats").doc(supportUser.uid);
  const supportUserChatRef = supportChatRootRef.collection("chats").doc(chatRef.id);
  const messageRef = chatRef.collection("messages").doc("support-started");
  const text = `Lend Support opened a ${target} dispute review chat for ${formatBookingSubject(booking, "this booking")}.`;
  const chatPayload = {
    id: chatRef.id,
    chatId: chatRef.id,
    bookingId: booking.id,
    renterId,
    bookingStartDate: booking.startDate || null,
    bookingEndDate: booking.endDate || null,
    bookingStatus: booking.status || null,
    asset: booking.asset || null,
    participants: [participant, supportUser].filter(Boolean),
    lastMessage: text,
    lastMessageDate: now,
    lastMessageSenderId: supportUser.uid,
    createdAt: now,
    hasRead: false,
    status: CHAT_STATUS.active,
    chatType: SUPPORT_CHAT_TYPE,
    supportTarget: target,
  };
  return {
    chatRef,
    userChatRootRef,
    userChatRef,
    supportChatRootRef,
    supportUserChatRef,
    messageRef,
    chatPayload,
    text,
    now,
    participantUserId,
    supportUser,
  };
}

function writeSupportChat(tx, supportChat) {
  tx.set(supportChat.chatRef, { chatType: SUPPORT_CHAT_TYPE }, { merge: true });
  tx.set(supportChat.userChatRootRef, { isOnline: true }, { merge: true });
  tx.set(supportChat.supportChatRootRef, { isOnline: true }, { merge: true });
  tx.set(supportChat.userChatRef, supportChat.chatPayload, { merge: true });
  tx.set(supportChat.supportUserChatRef, supportChat.chatPayload, { merge: true });
  tx.set(
    supportChat.messageRef,
    {
      id: supportChat.messageRef.id,
      text: supportChat.text,
      senderId: supportChat.supportUser.uid,
      createdAt: supportChat.now,
      type: "system",
      systemAction: "support_chat_created",
      visibleTo: [supportChat.participantUserId, supportChat.supportUser.uid].filter(Boolean),
    },
    { merge: true },
  );
}

function writeSupportSystemMessage(
  tx,
  {
    db = admin.firestore(),
    chatId,
    participantUserId,
    supportUser = getSupportUserSnapshot(),
    messageId,
    messageText,
    chatStatus = CHAT_STATUS.active,
    systemAction,
    extra = {},
    now = admin.firestore.FieldValue?.serverTimestamp() || new Date(),
  },
) {
  if (!chatId || !participantUserId || !messageId) return;
  const visibleTo = uniqueUserIds([participantUserId, supportUser.uid]);
  const chatRef = db.collection("chats").doc(chatId);
  const chatUpdate = {
    lastMessage: messageText,
    lastMessageDate: now,
    lastMessageSenderId: supportUser.uid,
    hasRead: false,
    status: chatStatus,
    chatType: SUPPORT_CHAT_TYPE,
  };
  tx.set(
    chatRef.collection("messages").doc(messageId),
    {
      id: messageId,
      text: messageText,
      senderId: supportUser.uid,
      createdAt: now,
      type: "system",
      systemAction,
      ...extra,
      visibleTo,
    },
    { merge: true },
  );
  tx.set(chatRef, chatUpdate, { merge: true });
  tx.set(db.collection("userChats").doc(participantUserId).collection("chats").doc(chatId), chatUpdate, {
    merge: true,
  });
  tx.set(db.collection("userChats").doc(supportUser.uid).collection("chats").doc(chatId), chatUpdate, { merge: true });
}

function deleteOutstandingDamagePaymentRequestMessage(tx, { db = admin.firestore(), chatId, bookingId }) {
  if (!chatId || !bookingId) return;
  tx.delete(
    db
      .collection("chats")
      .doc(chatId)
      .collection("messages")
      .doc(getLifecycleMessageId("outstanding-damage-payment-request", bookingId)),
  );
}

function getSupportUserSnapshot() {
  return {
    uid: process.env.LEND_SUPPORT_USER_ID || "lend_support",
    firstName: "Lend Support",
    lastName: "",
    displayName: "Lend Support",
    photoUrl: null,
    verified: "Full",
  };
}

async function loadOwnerDestination(booking) {
  const ownerId = booking?.asset?.owner?.uid;
  if (!ownerId) return null;
  const snap = await userPaymentProfileRef(ownerId).get();
  return snap.data()?.payoutDestination || null;
}

async function loadDepositReturnDestination(booking) {
  const renterId = booking?.renter?.uid;
  if (!renterId) return null;
  const snap = await userPaymentProfileRef(renterId).get();
  return snap.data()?.depositReturnDestination || null;
}

function toPayMongoReceiver(destination) {
  return {
    bank_id: destination.bankId,
    bank_code: destination.bankCode,
    bank_name: destination.bankName,
    bank_account_name: destination.accountName,
    bank_account_number: destination.accountNumber,
  };
}

function resolvePayoutProvider({ destination, amount }) {
  const supportedProviders = Array.isArray(destination?.supportedProviders) ? destination.supportedProviders : [];
  const supportsInstapay = supportedProviders.length === 0 || supportedProviders.includes("instapay");
  const supportsPesonet = supportedProviders.includes("pesonet");
  const instapayLimitAmount = 5000000;
  if (Number(amount) > instapayLimitAmount && supportsPesonet) return "pesonet";
  if (supportsInstapay) return "instapay";
  return supportsPesonet ? "pesonet" : destination?.provider || "instapay";
}

async function createBookingWalletMovement({
  booking,
  movementType,
  amount,
  destination,
  targetUserId,
  description,
  payoutFlowPatch,
}) {
  const normalizedAmount = roundCurrency(Number(amount || 0));
  const db = admin.firestore();
  const movementRef = bookingMovementRef(`${booking.id}_${movementType}`);
  const movementSnap = await movementRef.get();
  if (
    movementSnap.exists &&
    ![PAYOUT_STATUS.failed, PAYOUT_STATUS.configurationRequired].includes(movementSnap.data()?.status)
  ) {
    return { skipped: true, reason: "movement_exists", status: movementSnap.data()?.status };
  }
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0)
    return { skipped: true, reason: "zero_amount", status: PAYOUT_STATUS.skipped };
  const currency = bookingCurrency(booking);
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  const assetId = booking?.asset?.id;
  const renterId = booking?.renter?.uid;
  const { assetBookingRef, userBookingRef } = getBookingRefs({ assetId, bookingId: booking.id, renterId });

  if (process.env.FUNCTIONS_EMULATOR === "true") {
    await writeMovementStatus({
      db,
      movementRef,
      assetBookingRef,
      userBookingRef,
      status: PAYOUT_STATUS.succeeded,
      booking,
      movementType,
      amount: normalizedAmount,
      currency,
      now,
      targetUserId,
      payoutFlowPatch,
    });
    await sendOwnerPayoutProcessingNotice({ booking, movementType, amount: normalizedAmount, currency });
    return { skipped: false, status: PAYOUT_STATUS.succeeded, emulatorBypass: true };
  }
  if (!destination) {
    await writeMovementStatus({
      db,
      movementRef,
      assetBookingRef,
      userBookingRef,
      status: PAYOUT_STATUS.missingDestination,
      booking,
      movementType,
      amount: normalizedAmount,
      currency,
      now,
      targetUserId,
      error: "Payment destination is missing",
      payoutFlowPatch,
    });
    await sendPayoutEmail({ booking, ownerId: targetUserId, payoutStatus: PAYOUT_STATUS.missingDestination });
    return { skipped: true, reason: "missing_destination", status: PAYOUT_STATUS.missingDestination };
  }
  const walletId = getPayMongoWalletId();
  if (!walletId) {
    await writeMovementStatus({
      db,
      movementRef,
      assetBookingRef,
      userBookingRef,
      status: PAYOUT_STATUS.configurationRequired,
      booking,
      movementType,
      amount: normalizedAmount,
      currency,
      now,
      targetUserId,
      error: "PAYMONGO_WALLET_ID is not configured",
      payoutFlowPatch,
    });
    await sendPayoutEmail({ booking, ownerId: targetUserId, payoutStatus: PAYOUT_STATUS.configurationRequired });
    return { skipped: true, reason: "configuration_required", status: PAYOUT_STATUS.configurationRequired };
  }
  await writeMovementStatus({
    db,
    movementRef,
    assetBookingRef,
    userBookingRef,
    status: PAYOUT_STATUS.processing,
    booking,
    movementType,
    amount: normalizedAmount,
    currency,
    now,
    targetUserId,
    payoutFlowPatch,
  });
  await sendOwnerPayoutProcessingNotice({ booking, movementType, amount: normalizedAmount, currency });
  try {
    const walletTransaction = await createWalletTransaction({
      walletId,
      amount: normalizedAmount,
      currency,
      provider: resolvePayoutProvider({ destination, amount: normalizedAmount }),
      description,
      callbackUrl: getPayMongoWebhookUrl(),
      receiver: toPayMongoReceiver(destination),
    });
    const attrs = walletTransaction?.data?.attributes || {};
    const status = attrs.status || PAYOUT_STATUS.processing;
    await writeMovementStatus({
      db,
      movementRef,
      assetBookingRef,
      userBookingRef,
      status,
      booking,
      movementType,
      amount: normalizedAmount,
      currency,
      now: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      targetUserId,
      walletTransaction,
      paymongoWalletTransactionId: walletTransaction?.data?.id || null,
      referenceNumber: attrs.reference_number || null,
      payoutFlowPatch,
    });
    if (status && status !== PAYOUT_STATUS.processing) {
      await sendPayoutEmail({ booking, ownerId: targetUserId, payoutStatus: status });
    }
    return { skipped: false, status, paymongoWalletTransactionId: walletTransaction?.data?.id || null };
  } catch (error) {
    const normalized = normalizePayMongoError(error);
    await writeMovementStatus({
      db,
      movementRef,
      assetBookingRef,
      userBookingRef,
      status: PAYOUT_STATUS.failed,
      booking,
      movementType,
      amount: normalizedAmount,
      currency,
      now: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      targetUserId,
      error: normalized.message,
      paymongoErrors: normalized.errors,
      payoutFlowPatch,
    });
    await sendPayoutEmail({ booking, ownerId: targetUserId, payoutStatus: PAYOUT_STATUS.failed });
    return { skipped: false, status: PAYOUT_STATUS.failed, error: normalized.message };
  }
}

async function writeMovementStatus({
  db,
  movementRef,
  assetBookingRef,
  userBookingRef,
  status,
  booking,
  movementType,
  amount,
  currency,
  now,
  targetUserId,
  error,
  paymongoErrors,
  walletTransaction,
  paymongoWalletTransactionId,
  referenceNumber,
  payoutFlowPatch,
}) {
  const movementPayload = {
    id: movementRef.id,
    bookingId: booking.id,
    assetId: booking.asset?.id || null,
    renterId: booking.renter?.uid || null,
    ownerId: booking.asset?.owner?.uid || null,
    targetUserId: targetUserId || null,
    movementType,
    amount,
    currency: normalizeCurrency(currency || bookingCurrency(booking)),
    status,
    error: error || null,
    paymongoErrors: paymongoErrors || null,
    paymongoWalletTransactionId: paymongoWalletTransactionId || null,
    referenceNumber: referenceNumber || null,
    walletTransaction: walletTransaction || null,
    updatedAt: now,
    createdAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
  };
  await db.runTransaction(async (transaction) => {
    transaction.set(movementRef, movementPayload, { merge: true });
    const update = {
      payoutFlow: {
        ...(booking.payoutFlow || {}),
        ...(payoutFlowPatch || {}),
        ...(movementType === "renter_cancellation_owner_payout" ? { ownerPayoutStatus: status } : {}),
        movements: {
          ...((booking.payoutFlow || {}).movements || {}),
          [movementType]: movementPayload,
        },
        updatedAt: now,
      },
      lastUpdated: now,
    };
    transaction.set(assetBookingRef, update, { merge: true });
    transaction.set(userBookingRef, update, { merge: true });
    transaction.set(admin.firestore().collection("bookings").doc(booking.id), update, { merge: true });
  });
}

function buildRenterCancellationOwnerPayoutBreakdown({ booking, retainedOwnerAmount }) {
  const ownerPayoutGrossAmount = roundCurrency(Number(retainedOwnerAmount || 0));
  const transferFees =
    ownerPayoutGrossAmount > 0
      ? calculateWalletTransferFeeBreakdown(ownerPayoutGrossAmount, inferTransferFeeRules(booking))
      : emptyWalletTransferFeeBreakdown();
  const ownerPayoutTransferFee = transferFees.total;
  const ownerPayoutAmount = roundCurrency(Math.max(ownerPayoutGrossAmount - ownerPayoutTransferFee, 0));
  return {
    ownerPayoutGrossAmount,
    ownerPayoutTransferProviderFee: transferFees.provider,
    ownerPayoutTransferMarkupFee: transferFees.markup,
    ownerPayoutTransferFee,
    ownerPayoutAmount,
  };
}

async function writeRenterCancellationOwnerPayoutFlow({ booking, breakdown, status }) {
  const db = admin.firestore();
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  const assetId = booking?.asset?.id;
  const renterId = booking?.renter?.uid;
  const { assetBookingRef, userBookingRef } = getBookingRefs({ assetId, bookingId: booking.id, renterId });
  const update = {
    payoutFlow: {
      ...(booking.payoutFlow || {}),
      ...breakdown,
      ownerPayoutStatus: status,
      updatedAt: now,
    },
    lastUpdated: now,
  };

  await db.runTransaction(async (transaction) => {
    transaction.set(assetBookingRef, update, { merge: true });
    transaction.set(userBookingRef, update, { merge: true });
    transaction.set(admin.firestore().collection("bookings").doc(booking.id), update, { merge: true });
  });
}

async function createOwnerCancellationPayout({ booking, amount, allowEmulatorBypass = false }) {
  const ownerId = booking?.asset?.owner?.uid;
  const ownerProfileSnap = ownerId ? await userPaymentProfileRef(ownerId).get() : null;
  const breakdown = buildRenterCancellationOwnerPayoutBreakdown({
    booking,
    retainedOwnerAmount: amount,
  });
  if (breakdown.ownerPayoutAmount <= 0) {
    await writeRenterCancellationOwnerPayoutFlow({
      booking,
      breakdown,
      status: PAYOUT_STATUS.skipped,
    });
    return {
      skipped: true,
      reason: "zero_net_owner_payout",
      status: PAYOUT_STATUS.skipped,
      ...breakdown,
    };
  }
  if (allowEmulatorBypass && process.env.FUNCTIONS_EMULATOR === "true") {
    process.env.FUNCTIONS_EMULATOR = "true";
  }
  const result = await createBookingWalletMovement({
    booking,
    movementType: "renter_cancellation_owner_payout",
    amount: breakdown.ownerPayoutAmount,
    destination: ownerProfileSnap?.data()?.payoutDestination || null,
    targetUserId: ownerId,
    description: `Lend renter cancellation owner payout ${booking?.id}`,
    payoutFlowPatch: breakdown,
  });
  return { ...result, ...breakdown };
}

module.exports = {
  ACTIVE_BOOKING_STATUSES,
  BOOKING_STATUS,
  CHAT_STATUS,
  CHECKOUT_STATUS,
  CHECKOUT_TYPE,
  DEPOSIT_FLOW_STATUS,
  DISPUTE_STATUS,
  FieldValue,
  LOCKED_CHECKOUT_STATUSES,
  PAYOUT_STATUS,
  admin,
  assertReturnedAwaitingOwnerAction,
  attachPaymentMethod,
  bookingCurrency,
  bookingMovementRef,
  buildBookingMirrorUpdate,
  buildBookingPriceBreakdown,
  buildDamageRequestSettlementPlan,
  buildOutstandingDamagePriceBreakdown,
  buildPaymentFlow,
  buildPendingRecoveryPayload,
  buildProviderPayoutInstitutionLists,
  buildSupportChatWrite,
  buildTokenUpdateData,
  calculateFee,
  calculatePaymentMethodFee,
  calculateRentalSubtotal,
  cancelSubscription,
  cancelCheckoutSubscriptions,
  checkoutDateLockRefs,
  classifyInstitution,
  createBookingWalletMovement,
  createConfirmedBookingFromCheckout,
  createOwnerCancellationPayout,
  createPaymentIntent,
  createSubscription,
  createSubscriptionPlan,
  createWalletTransaction,
  deleteOutstandingDamagePaymentRequestMessage,
  extractPaymentId,
  extractPaymentMethodType,
  finalizeBookingSettlement,
  findPaymentIntentId,
  formatBookingPurpose,
  formatBookingStartDate,
  formatBookingSubject,
  formatNewBookingNotificationBody,
  getBookingActors,
  getBookingRefs,
  getDepositAmount,
  getLifecycleMessageId,
  getOrCreatePayMongoCustomerId,
  getPayMongoCheckoutReturnUrl,
  getPayMongoEventId,
  getPayMongoEventType,
  getPayMongoPaymentIntentId,
  getPayMongoSubscriptionId,
  getPayMongoPublicKey,
  getPayMongoWalletId,
  getPayMongoWebhookUrl,
  getPricingPolicyConfig,
  getSupportUserSnapshot,
  handlePayMongoEvent,
  inferTransferFeeRule,
  inferTransferFeeRules,
  isClientCancellableCheckoutStatus,
  isSupportReviewReason,
  latestPayment,
  latestPaymentAttributes,
  listCustomerPaymentMethods,
  listReceivingInstitutions,
  listingCurrencyFromAsset,
  loadDepositReturnDestination,
  loadOwnerDestination,
  markCheckoutTerminal,
  markOutstandingDamageCheckoutPaid,
  markOutstandingDamageRequired,
  normalizeBookingRange,
  normalizeClientCancelReason,
  normalizeCurrency,
  normalizeEvidenceUrls,
  normalizeInstitutionPayload,
  normalizeNonNegativeAmount,
  normalizeOptionalText,
  normalizePayMongoError,
  normalizePayoutDestination,
  normalizePositiveAmount,
  normalizeRequiredText,
  normalizeSecurityDeposit,
  normalizeSelectedPaymentMethod,
  normalizeSelectedPaymentMethodDetails,
  paymentCheckoutRef,
  paymentIntentAttributes,
  paymentIntentId,
  pendingBookingCountIncrementValue,
  releaseCheckoutDateLocks,
  reserveCheckoutDateLocks,
  resolveCheckoutLockExpiryMs,
  resolvePaymentMethodFee,
  resolvePayoutProvider,
  retrievePaymentIntent,
  retrieveSubscription,
  roundCurrency,
  sendNotificationToUser,
  sortInstitutionByName,
  syncCheckoutFromPaymentIntent,
  syncPaymentSession,
  terminalRecoveryResult,
  throwAndLogHttpsError,
  toPayMongoAmount,
  toPayMongoReceiver,
  toSavedPaymentMethod,
  toAssetSnapshot,
  toSimpleUser,
  updatePaymentMethodCvc,
  updatePayoutFlowAfterMovements,
  updateRecommendationProfile,
  userPaymentProfileRef,
  verifyWebhookSignature,
  writeBookingAndMirrors,
  writeSubscriptionMappings,
  writeMovementStatus,
  writeSupportChat,
  writeSupportSystemMessage,
  writeSystemMessage,
  writeVisibleSystemMessage,
  _test: {
    archiveExistingDisputeSupportChats,
    buildBookingPriceBreakdown,
    calculateWalletTransferFeeBreakdown,
    buildDamageRequestSettlementPlan,
    deleteOutstandingDamagePaymentRequestMessage,
    buildDepositReturnProcessingNotificationRequest,
    buildDepositReturnProcessingNotice,
    buildFinalizedBookingSettlement,
    buildFinalOwnerPayoutBreakdown,
    buildRenterCancellationOwnerPayoutBreakdown,
    buildOwnerPenaltyDeduction,
    buildOwnerPayoutProcessingNotificationRequest,
    buildOwnerPayoutProcessingNotice,
    buildOutstandingDamagePaidBookingState,
    buildOutstandingDamagePriceBreakdown,
    buildProviderPayoutInstitutionLists,
    formatNewBookingNotificationBody,
    getPayMongoEventId,
    getPayMongoEventType,
    getPayMongoPaymentIntentId,
    normalizePayMongoCustomerPhone,
    normalizePayMongoCustomerText,
    assertReturnedAwaitingOwnerAction,
    isClientCancellableCheckoutStatus,
    normalizeClientCancelReason,
    terminalRecoveryResult,
    applyOwnerPenaltyDeductionToBooking,
    writeCompletionRatingPrompt,
    writeDepositReturnProcessingMessage,
    writeOwnerCancellationPenaltyApplications,
    writeOwnerPayoutProcessingMessage,
    writeSupportSystemMessage,
    writeVisibleSystemMessage,
  },
};
