const admin = require("firebase-admin");
const { sendSystemChatMessage } = require("../utils/chat.util"); // Import the chat utility
const { throwAndLogHttpsError } = require("../utils/error.util"); // Import the error utility
const { validateSignedQrToken } = require("../utils/token.util");
const {
  assertCanonicalBookingRange,
  assertBookingParticipant,
  assertQrScannerAuthorized,
  assertTokenActionAvailableOrCompleted,
  formatBookingPurpose,
  getExpectedTokenForAction,
  getLifecycleMessageId,
  getTargetStatusForAction,
  isTokenActionCompleted,
  buildBookingMirrorUpdate,
} = require("../utils/booking.util");

function isDebugQrBypassAllowed() {
  return process.env.FUNCTIONS_EMULATOR === "true";
}

function assertDebugQrBypassAllowed() {
  if (!isDebugQrBypassAllowed()) {
    throwAndLogHttpsError(
      "permission-denied",
      "Debug QR bypass is only available in the functions emulator",
    );
  }
}

exports.verifyAndMark = async (request) => {
  const { token, debugBypass } = request.data || {};
  const auth = request.auth;

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (debugBypass === true) {
    assertDebugQrBypassAllowed();
  }

  const { payload, payloadB64 } = validateSignedQrToken({ token });
  const { bookingId, userId, assetId, action, uuid } = payload;

  // --- Firestore references ---
  const rootBookingRef = admin.firestore().doc(`bookings/${bookingId}`);
  const userBookingRef = admin.firestore().doc(`users/${userId}/bookings/${bookingId}`);
  const assetBookingRef = admin.firestore().doc(`assets/${assetId}/bookings/${bookingId}`);

  let chatID = null;
  let ownerID = null;
  let alreadyCompleted = false;
  let targetStatus = null;
  let bookingForMessage = null;

  // --- Run transaction ---
  await admin.firestore().runTransaction(async (tx) => {
    const [rootSnap, userSnap, assetSnap] = await Promise.all([
      tx.get(rootBookingRef),
      tx.get(userBookingRef),
      tx.get(assetBookingRef),
    ]);

    if (!rootSnap.exists || !userSnap.exists || !assetSnap.exists) {
      throwAndLogHttpsError("not-found", "Booking not found");
    }

    const rootBooking = rootSnap.data();
    const userBooking = userSnap.data();
    const assetBooking = assetSnap.data();
    const tokens = rootBooking?.tokens || userBooking?.tokens || assetBooking?.tokens;

    if (!tokens) {
      throwAndLogHttpsError("not-found", "No tokens found in booking");
    }

    assertTokenActionAvailableOrCompleted(rootBooking, action);
    assertTokenActionAvailableOrCompleted(userBooking, action);
    assertTokenActionAvailableOrCompleted(assetBooking, action);
    assertCanonicalBookingRange(rootBooking);
    if (debugBypass === true) {
      assertBookingParticipant(auth.uid, rootBooking);
    } else {
      assertQrScannerAuthorized({
        authUid: auth.uid,
        action,
        booking: rootBooking,
      });
    }

    // Retrieve chatID and ownerID for sending system message
    chatID = rootBooking.chatId;
    ownerID = rootBooking.asset.owner.uid;
    bookingForMessage = rootBooking;

    const expectedToken = getExpectedTokenForAction(tokens, action);
    if (!expectedToken || expectedToken !== token) {
      throwAndLogHttpsError("permission-denied", "Token mismatch or outdated QR");
    }

    const expectedPayloadB64 = expectedToken.split(".")[0];
    if (expectedPayloadB64 !== payloadB64) {
      throwAndLogHttpsError("permission-denied", "Invalid token payload");
    }

    alreadyCompleted =
      isTokenActionCompleted(rootBooking, action) ||
      isTokenActionCompleted(userBooking, action) ||
      isTokenActionCompleted(assetBooking, action);

    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
    const fromStatus = rootBooking.status;
    const toStatus = getTargetStatusForAction(action);
    targetStatus = toStatus;

    if (!alreadyCompleted) {
      const updateData = {
        status: toStatus,
        ...(action === "return"
          ? {
              depositFlow: {
                ...(rootBooking.depositFlow || {}),
                status:
                  rootBooking?.depositFlow?.required === true || rootBooking?.securityDeposit?.enabled === true
                    ? "awaiting_owner_action"
                    : "none",
                updatedAt: now,
              },
            }
          : {}),
        lastUpdated: now,
      };
      const updatedBooking = {
        ...rootBooking,
        ...updateData,
      };

      tx.update(rootBookingRef, updateData);
      tx.set(userBookingRef, buildBookingMirrorUpdate(updatedBooking), { merge: true });
      tx.set(assetBookingRef, buildBookingMirrorUpdate(updatedBooking), { merge: true });
    }

    if (!alreadyCompleted) {
      const event = {
        type: action,
        actorId: auth.uid,
        fromStatus,
        toStatus,
        createdAt: now,
        tokenUuid: uuid,
      };
      tx.set(rootBookingRef.collection("events").doc(`${action}-${uuid}`), event, { merge: true });
      tx.set(userBookingRef.collection("events").doc(`${action}-${uuid}`), event, { merge: true });
      tx.set(assetBookingRef.collection("events").doc(`${action}-${uuid}`), event, { merge: true });
    }
  });

  let systemMessageText = "";
  if (action === "handover") {
    systemMessageText = formatBookingPurpose(bookingForMessage, "was handed over.", "A booking");
  } else if (action === "return") {
    systemMessageText = formatBookingPurpose(bookingForMessage, "was returned.", "A booking");
  }

  // Send system chat message for handover/return
  if (systemMessageText) {
    await sendSystemChatMessage({
      chatId: chatID,
      ownerId: ownerID,
      renterId: userId,
      messageText: systemMessageText,
      messageType: "system", // MessageType.system for general updates
      messageId: getLifecycleMessageId(action, bookingId),
    });

    const ownerUserChatRef = admin.firestore().collection("userChats").doc(ownerID).collection("chats").doc(chatID);
    const renterUserChatRef = admin.firestore().collection("userChats").doc(userId).collection("chats").doc(chatID);

    await admin.firestore().runTransaction(async (tx) => {
      tx.update(ownerUserChatRef, { bookingStatus: targetStatus });
      tx.update(renterUserChatRef, { bookingStatus: targetStatus });
    });
  }

  return {
    success: true,
    alreadyCompleted,
    message: alreadyCompleted
      ? `Booking ${bookingId} was already marked as ${action}`
      : `Booking ${bookingId} successfully marked as ${action}`,
  };
};

exports._test = {
  assertDebugQrBypassAllowed,
  isDebugQrBypassAllowed,
};
