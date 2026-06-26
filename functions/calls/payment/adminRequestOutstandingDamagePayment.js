const {
  CHAT_STATUS,
  DEPOSIT_FLOW_STATUS,
  DISPUTE_STATUS,
  admin,
  bookingCurrency,
  getBookingActors,
  getDepositAmount,
  getLifecycleMessageId,
  getSupportUserSnapshot,
  normalizePositiveAmount,
  roundCurrency,
  throwAndLogHttpsError,
  writeBookingAndMirrors,
  writeSupportSystemMessage,
} = require("./utils/paymentFlow.util");

async function adminRequestOutstandingDamagePayment(request) {
  const auth = request.auth;
  const { bookingId, chatId, amount } = request.data || {};
  if (!auth?.token?.admin) throwAndLogHttpsError("permission-denied", "Only admins can request damage payment");
  const paymentAmount = normalizeWholePositiveAmount(amount, "outstanding damage amount");
  const db = admin.firestore();
  const bookingRef = db.collection("bookings").doc(bookingId);
  let paymentRequestId = null;
  let paymentStateSummary = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(bookingRef);
    if (!snap.exists) throwAndLogHttpsError("not-found", "Booking not found");
    const booking = snap.data();
    const { renterId } = getBookingActors(booking);
    const supportChatId = resolveRenterSupportChatId(booking, chatId);
    assertCanRequestOutstandingDamagePayment(booking);
    paymentRequestId = db.collection("damageBalancePaymentRequests").doc().id;
    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
    const requestRef = db.collection("damageBalancePaymentRequests").doc(paymentRequestId);
    const paymentState = buildOutstandingDamagePaymentState({
      booking,
      paymentAmount,
      paymentRequestId,
      now,
    });
    paymentStateSummary = {
      approvedDamageDeductionAmount: paymentState.settlement.approvedDamageDeductionAmount,
      depositCoveredDamageAmount: paymentState.settlement.depositCoveredDamageAmount,
      depositReturnAmount: paymentState.settlement.depositReturnAmount,
      outstandingDamageAmount: paymentState.settlement.outstandingDamageAmount,
      status: paymentState.settlement.status,
      supportStatus: paymentState.settlement.supportStatus,
    };
    tx.set(requestRef, {
      id: paymentRequestId,
      bookingId,
      chatId: supportChatId,
      renterId,
      amount: paymentAmount,
      currency: bookingCurrency(booking),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    const updatedBooking = {
      ...booking,
      ...paymentState,
      lastUpdated: now,
    };
    writeBookingAndMirrors(tx, updatedBooking);
    writeOutstandingDamagePaymentSupportMessage(tx, {
      db,
      booking: updatedBooking,
      chatId: supportChatId,
      renterId,
      paymentRequestId,
      amount: paymentAmount,
      currency: bookingCurrency(booking),
      now,
    });
  });
  return { success: true, paymentRequestId, ...paymentStateSummary };
}

function normalizeWholePositiveAmount(value, fieldName) {
  const amount = normalizePositiveAmount(value, fieldName);
  if (!Number.isInteger(amount)) throwAndLogHttpsError("invalid-argument", `Invalid ${fieldName}`);
  return amount;
}

function assertCanRequestOutstandingDamagePayment(booking) {
  const paymentStatus = booking?.disputeFlow?.outstandingPaymentStatus || booking?.settlement?.damageBalancePaymentStatus || null;
  if (["pending", "paid"].includes(paymentStatus)) {
    throwAndLogHttpsError("failed-precondition", "Outstanding damage payment is already pending or paid");
  }
  const ownerBalancePayoutStatus = booking?.settlement?.ownerDamageBalancePayoutStatus || null;
  if (["processing", "succeeded"].includes(ownerBalancePayoutStatus)) {
    throwAndLogHttpsError("failed-precondition", "Outstanding damage settlement has already been released");
  }
}

function buildOutstandingDamagePaymentState({ booking, paymentAmount, paymentRequestId, now }) {
  const depositAmount = roundCurrency(Math.max(getDepositAmount(booking), 0));
  const depositCoveredAmount = depositAmount > 0 ? depositAmount : 0;
  const approvedAmount = roundCurrency(depositCoveredAmount + paymentAmount);
  const remainingSecurityDeposit = roundCurrency(Math.max(depositAmount - depositCoveredAmount, 0));
  return {
    depositFlow: {
      ...(booking.depositFlow || {}),
      status: DEPOSIT_FLOW_STATUS.outstandingPaymentPending,
      approvedDeductionAmount: approvedAmount,
      depositCoveredAmount,
      depositReturnAmount: remainingSecurityDeposit,
      updatedAt: now,
    },
    disputeFlow: {
      ...(booking.disputeFlow || {}),
      status: DISPUTE_STATUS.outstandingPaymentPending,
      approvedAmount,
      depositCoveredAmount,
      outstandingAmount: paymentAmount,
      outstandingPaymentRequestId: paymentRequestId,
      outstandingPaymentStatus: "pending",
      remainingSecurityDeposit,
      updatedAt: now,
    },
    settlement: {
      ...(booking.settlement || {}),
      status: DISPUTE_STATUS.outstandingPaymentPending,
      supportStatus: DISPUTE_STATUS.supportReview,
      approvedDamageDeductionAmount: approvedAmount,
      depositCoveredDamageAmount: depositCoveredAmount,
      outstandingDamageAmount: paymentAmount,
      depositReturnAmount: remainingSecurityDeposit,
      damageBalancePaymentRequestId: paymentRequestId,
      damageBalancePaymentStatus: "pending",
      damageBalanceRequestedAmount: paymentAmount,
      ownerDamageBalancePayoutStatus: null,
      updatedAt: now,
    },
  };
}

function resolveRenterSupportChatId(booking, requestedChatId) {
  const supportChatId = booking?.disputeFlow?.renterSupportChatId || null;
  if (!supportChatId) throwAndLogHttpsError("failed-precondition", "Renter support chat is required before requesting damage payment");
  if (requestedChatId && requestedChatId !== supportChatId) throwAndLogHttpsError("failed-precondition", "Support chat does not match this booking");
  return supportChatId;
}

function writeOutstandingDamagePaymentSupportMessage(tx, { db, booking, chatId, renterId, paymentRequestId, amount, currency, now }) {
  const supportUser = getSupportUserSnapshot();
  writeSupportSystemMessage(tx, {
    db,
    chatId,
    participantUserId: renterId,
    supportUser,
    messageId: getLifecycleMessageId("outstanding-damage-payment-request", booking.id),
    messageText: `Outstanding damage payment requested: ${currency} ${amount}.`,
    chatStatus: CHAT_STATUS.active,
    systemAction: "damage_balance_payment_request",
    extra: buildOutstandingDamagePaymentMessageExtra({
      paymentRequestId,
      amount,
      currency,
    }),
    now,
  });
}

function buildOutstandingDamagePaymentMessageExtra({ paymentRequestId, amount, currency }) {
  return {
    damagePaymentRequestId: paymentRequestId,
    paymentRequestId,
    paymentStatus: "pending",
    amount,
    currency,
  };
}

module.exports = {
  adminRequestOutstandingDamagePayment,
  _test: {
    assertCanRequestOutstandingDamagePayment,
    buildOutstandingDamagePaymentState,
    buildOutstandingDamagePaymentMessageExtra,
    normalizeWholePositiveAmount,
    resolveRenterSupportChatId,
    writeOutstandingDamagePaymentSupportMessage,
  },
};
