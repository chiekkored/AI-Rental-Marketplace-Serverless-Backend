const {
  FieldValue,
  admin,
  buildSupportChatWrite,
  throwAndLogHttpsError,
  writeBookingAndMirrors,
  writeSupportChat,
} = require("./utils/paymentFlow.util");

async function adminCreateDisputeSupportChat(request) {
  const auth = request.auth;
  const { bookingId, target } = request.data || {};
  if (!auth?.token?.admin) throwAndLogHttpsError("permission-denied", "Only admins can create support chats");
  const normalizedTarget = target === "owner" ? "owner" : "renter";
  const db = admin.firestore();
  const bookingRef = db.collection("bookings").doc(bookingId);
  let resultChatId = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(bookingRef);
    if (!snap.exists) throwAndLogHttpsError("not-found", "Booking not found");
    const booking = snap.data();
    if (!booking.disputeFlow) throwAndLogHttpsError("failed-precondition", "Booking has no dispute context");
    const fieldName = normalizedTarget === "renter" ? "renterSupportChatId" : "ownerSupportChatId";
    if (booking.disputeFlow[fieldName]) {
      resultChatId = booking.disputeFlow[fieldName];
      return;
    }
    const supportChat = buildSupportChatWrite({ db, booking, target: normalizedTarget, now: admin.firestore.FieldValue?.serverTimestamp() || new Date() });
    resultChatId = supportChat.chatRef.id;
    const updatedBooking = {
      ...booking,
      disputeFlow: { ...booking.disputeFlow, [fieldName]: resultChatId, supportStatus: booking.disputeFlow.supportStatus || "pending", updatedAt: supportChat.now },
      lastUpdated: supportChat.now,
    };
    writeBookingAndMirrors(tx, updatedBooking);
    writeSupportChat(tx, supportChat);
  });
  return { success: true, target: normalizedTarget, chatId: resultChatId };
}

module.exports = { adminCreateDisputeSupportChat };
