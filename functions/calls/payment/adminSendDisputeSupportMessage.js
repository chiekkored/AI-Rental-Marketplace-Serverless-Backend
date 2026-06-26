const {
  FieldValue,
  admin,
  getSupportUserSnapshot,
  normalizeRequiredText,
  throwAndLogHttpsError,
} = require("./utils/paymentFlow.util");

function buildAdminDisputeSupportChatUpdates({ text, now, supportUserId }) {
  const commonUpdate = {
    lastMessage: text,
    lastMessageDate: now,
    lastMessageSenderId: supportUserId,
  };

  return {
    rootChatUpdate: { ...commonUpdate, hasRead: false },
    participantChatUpdate: { ...commonUpdate, hasRead: false },
    supportChatUpdate: { ...commonUpdate, hasRead: true },
  };
}

async function adminSendDisputeSupportMessage(request) {
  const auth = request.auth;
  const { bookingId, target, chatId, text } = request.data || {};
  if (!auth?.token?.admin) throwAndLogHttpsError("permission-denied", "Only admins can send support messages");
  if (!bookingId || !chatId) throwAndLogHttpsError("invalid-argument", "Missing support chat details");
  const normalizedText = normalizeRequiredText(text, "message", 2000);
  const normalizedTarget = target === "owner" ? "owner" : "renter";
  const db = admin.firestore();
  const snap = await db.collection("bookings").doc(bookingId).get();
  if (!snap.exists) throwAndLogHttpsError("not-found", "Booking not found");
  const booking = snap.data();
  const expectedChatId = normalizedTarget === "owner" ? booking?.disputeFlow?.ownerSupportChatId : booking?.disputeFlow?.renterSupportChatId;
  if (expectedChatId !== chatId) throwAndLogHttpsError("failed-precondition", "Support chat does not match this booking");
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  const supportUser = getSupportUserSnapshot();
  const participantUserId = normalizedTarget === "owner" ? booking.asset?.owner?.uid : booking.renter?.uid;
  const messageRef = db.collection("chats").doc(chatId).collection("messages").doc();
  await db.runTransaction(async (tx) => {
    tx.set(messageRef, {
      id: messageRef.id,
      text: normalizedText,
      senderId: supportUser.uid,
      createdAt: now,
      type: "text",
      visibleTo: [participantUserId, supportUser.uid].filter(Boolean),
    });
    const { rootChatUpdate, participantChatUpdate, supportChatUpdate } = buildAdminDisputeSupportChatUpdates({
      text: normalizedText,
      now,
      supportUserId: supportUser.uid,
    });
    tx.set(db.collection("chats").doc(chatId), rootChatUpdate, { merge: true });
    tx.set(db.collection("userChats").doc(participantUserId).collection("chats").doc(chatId), participantChatUpdate, { merge: true });
    tx.set(db.collection("userChats").doc(supportUser.uid).collection("chats").doc(chatId), supportChatUpdate, { merge: true });
  });
  return { success: true, target: normalizedTarget, chatId, messageId: messageRef.id };
}

module.exports = {
  adminSendDisputeSupportMessage,
  _test: { buildAdminDisputeSupportChatUpdates },
};
