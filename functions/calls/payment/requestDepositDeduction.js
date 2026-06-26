const {
  CHAT_STATUS,
  DEPOSIT_FLOW_STATUS,
  DISPUTE_STATUS,
  admin,
  assertReturnedAwaitingOwnerAction,
  buildDamageRequestSettlementPlan,
  formatBookingSubject,
  getBookingActors,
  getDepositAmount,
  normalizeEvidenceUrls,
  normalizeOptionalText,
  normalizeRequiredText,
  sendNotificationToUser,
  throwAndLogHttpsError,
  writeBookingAndMirrors,
  writeSystemMessage,
} = require("./utils/paymentFlow.util");
const { firstListingImageUrl } = require("../../utils/notification.util");

async function requestDepositDeduction(request) {
  const auth = request.auth;
  const { bookingId, requestedAmount, reason, notes, evidenceUrls } = request.data || {};
  if (!auth) throwAndLogHttpsError("permission-denied", "User must be authenticated");
  if (!bookingId) throwAndLogHttpsError("invalid-argument", "Missing bookingId");
  const normalizedReason = normalizeRequiredText(reason, "reason", 240);
  const normalizedNotes = normalizeOptionalText(notes, 1000);
  const normalizedEvidence = normalizeEvidenceUrls(evidenceUrls);
  const db = admin.firestore();
  const bookingRef = db.collection("bookings").doc(bookingId);
  let result = null;
  let notification = null;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(bookingRef);
    if (!snap.exists) throwAndLogHttpsError("not-found", "Booking not found");
    const booking = snap.data();
    const { ownerId, renterId, chatId } = getBookingActors(booking);
    if (auth.uid !== ownerId) throwAndLogHttpsError("permission-denied", "Only the owner can request a deposit deduction");
    assertReturnedAwaitingOwnerAction(booking);
    const depositAmount = getDepositAmount(booking);
    const damagePlan = buildDamageRequestSettlementPlan({
      depositAmount,
      requestedAmount,
      reason: normalizedReason,
    });
    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
    const { amount, outstandingAmount, needsSupport } = damagePlan;
    const disputeFlow = {
      id: `dispute_${bookingId}`,
      status: needsSupport ? DISPUTE_STATUS.supportReview : DISPUTE_STATUS.requested,
      requestedAmount: amount,
      depositCoveredAmount: damagePlan.depositCoveredAmount,
      outstandingAmount,
      reason: normalizedReason,
      notes: normalizedNotes,
      evidenceUrls: normalizedEvidence,
      requestedBy: auth.uid,
      requestedAt: now,
      renterResponse: needsSupport ? null : "awaiting_renter_response",
      supportStatus: needsSupport ? "pending" : null,
      updatedAt: now,
    };
    const updatedBooking = {
      ...booking,
      depositFlow: {
        ...(booking.depositFlow || {}),
        status: needsSupport ? DEPOSIT_FLOW_STATUS.supportReview : DEPOSIT_FLOW_STATUS.awaitingRenterResponse,
        requestedDeductionAmount: amount,
        updatedAt: now,
      },
      disputeFlow,
      lastUpdated: now,
    };
    writeBookingAndMirrors(tx, updatedBooking);
    writeSystemMessage(tx, {
      booking: updatedBooking,
      messageText: needsSupport
        ? "A damage request is under Lend Support review."
        : "A security deposit deduction request is awaiting renter response.",
      messageName: "deposit-deduction-requested",
      chatStatus: CHAT_STATUS.active,
    });
    notification = {
      uid: renterId,
      title: needsSupport ? "Damage fee request submitted" : "Deposit deduction requested",
      body: needsSupport
        ? `${formatBookingSubject(booking)} has a damage fee request for Lend Support review.`
        : `${formatBookingSubject(booking)} has a deposit deduction request.`,
      imageUrl: firstListingImageUrl(booking?.asset),
      push: false,
      data: {
        type: "booking",
        notificationCategory: "payments",
        chatId,
        bookingId,
        assetId: booking?.asset?.id || null,
        senderId: auth.uid,
      },
    };
    result = { success: true, status: disputeFlow.status, outstandingAmount };
  });

  if (notification) {
    await sendNotificationToUser(notification).catch((error) => {
      console.warn(`[requestDepositDeduction] Failed to notify renter: ${error.message}`);
    });
  }
  return result;
}

module.exports = { requestDepositDeduction };
