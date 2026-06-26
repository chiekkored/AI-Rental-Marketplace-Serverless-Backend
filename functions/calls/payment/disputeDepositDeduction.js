const {
  CHAT_STATUS,
  DEPOSIT_FLOW_STATUS,
  DISPUTE_STATUS,
  FieldValue,
  admin,
  formatBookingSubject,
  getBookingActors,
  sendNotificationToUser,
  throwAndLogHttpsError,
  writeBookingAndMirrors,
  writeSystemMessage,
} = require("./utils/paymentFlow.util");
const { firstListingImageUrl } = require("../../utils/notification.util");

async function disputeDepositDeduction(request) {
  const auth = request.auth;
  const { bookingId } = request.data || {};
  if (!auth) throwAndLogHttpsError("permission-denied", "User must be authenticated");
  if (!bookingId) throwAndLogHttpsError("invalid-argument", "Missing bookingId");
  const db = admin.firestore();
  const bookingRef = db.collection("bookings").doc(bookingId);
  let notification = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(bookingRef);
    if (!snap.exists) throwAndLogHttpsError("not-found", "Booking not found");
    const booking = snap.data();
    const { ownerId, renterId, chatId } = getBookingActors(booking);
    if (auth.uid !== renterId) throwAndLogHttpsError("permission-denied", "Only the renter can dispute this deduction");
    if (booking?.disputeFlow?.status !== DISPUTE_STATUS.requested) {
      throwAndLogHttpsError("failed-precondition", "Booking is not awaiting renter deposit response");
    }
    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
    const updatedBooking = {
      ...booking,
      depositFlow: { ...(booking.depositFlow || {}), status: DEPOSIT_FLOW_STATUS.disputed, renterResponse: "disputed", updatedAt: now },
      disputeFlow: { ...(booking.disputeFlow || {}), status: DISPUTE_STATUS.disputed, renterResponse: "disputed", supportStatus: "pending", renterRespondedAt: now, updatedAt: now },
      lastUpdated: now,
    };
    writeBookingAndMirrors(tx, updatedBooking);
    writeSystemMessage(tx, {
      booking: updatedBooking,
      messageText: "The security deposit deduction request was disputed. Lend Support review is required.",
      messageName: "deposit-deduction-disputed",
      chatStatus: CHAT_STATUS.active,
    });
    notification = {
      uid: ownerId,
      title: "Deposit request disputed",
      body: `${formatBookingSubject(booking)} deposit deduction request was disputed.`,
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
  });
  if (notification) await sendNotificationToUser(notification).catch(() => {});
  return { success: true, status: DISPUTE_STATUS.disputed };
}

module.exports = { disputeDepositDeduction };
