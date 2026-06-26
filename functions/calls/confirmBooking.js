const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  BOOKING_STATUS,
  ACTIVE_BOOKING_STATUSES,
  buildTokenUpdateData,
  buildBookingMirrorUpdate,
  assertBookingOwner,
  assertCanonicalBookingRange,
  assertPendingBooking,
  formatBookingPurpose,
  getBookingActors,
  getLifecycleMessageId,
} = require("../utils/booking.util");
const {
  getDeclineOverlappingBookingsUrl,
  getTaskServiceAccountEmail,
  isFunctionsEmulator,
  resolveProjectId,
} = require("../utils/task.util");
const { pendingBookingCountIncrementValue } = require("../utils/pendingBookingCount.util");
const { PRIMARY_FUNCTIONS_REGION } = require("../utils/functionsRegion.util");
const { sendBookingConfirmedEmails } = require("../utils/transactionalEmail.util");

/**
 * Cloud Function: Two-Phase Booking Confirmation
 *
 * PHASE 1 (Atomic): Confirms selected booking immediately in a transaction
 * PHASE 2 (Async): Enqueues Cloud Tasks to decline overlapping pending bookings
 *
 * Benefit: Selected booking confirmed IMMEDIATELY (strong consistency)
 *          Declining others is best-effort via queue (eventual consistency ok)
 *          Handles 500+ overlapping bookings without transaction timeout
 *
 * Requires: Cloud Tasks API enabled + queue "decline-overlapping-bookings" created
 */
exports.confirmBooking = async (request) => {
  const data = request.data;
  const context = { auth: request.auth };

  const db = admin.firestore();
  const { bookingId, assetId, renterId } = data;

  // --- AUTHENTICATION & VALIDATION ---
  if (!context.auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (!bookingId || !assetId || !renterId) {
    throwAndLogHttpsError("invalid-argument", "Missing bookingId, assetId, or renterId");
  }

  const selectedBookingRef = db.doc(`assets/${assetId}/bookings/${bookingId}`);
  const userBookingRef = db.doc(`users/${renterId}/bookings/${bookingId}`);
  const rootBookingRef = db.doc(`bookings/${bookingId}`);

  try {
    // --- PHASE 1: ATOMIC TRANSACTION (Confirm selected booking) ---
    const confirmResult = await db.runTransaction(async (transaction) => {
      const selectedSnap = await transaction.get(selectedBookingRef);
      const userBookingSnap = await transaction.get(userBookingRef);
      const rootBookingSnap = await transaction.get(rootBookingRef);

      if (!selectedSnap.exists || !userBookingSnap.exists || !rootBookingSnap.exists) {
        throw new Error("Booking not found");
      }

      const booking = rootBookingSnap.data();
      assertBookingOwner(context.auth.uid, booking);
      const range = assertCanonicalBookingRange(booking);
      assertPendingBooking(booking);
      const { ownerId } = getBookingActors(booking);
      const ownerAssetMirrorRef = ownerId
        ? db.collection("users").doc(ownerId).collection("assets").doc(assetId)
        : null;
      const ownerAssetMirrorSnap = ownerAssetMirrorRef ? await transaction.get(ownerAssetMirrorRef) : null;

      if (booking?.renter?.uid !== renterId) {
        throw new Error("Booking renter does not match request");
      }

      const activeOverlapQuery = db
        .collection("assets")
        .doc(assetId)
        .collection("bookings")
        .where("startDate", "<", admin.firestore.Timestamp?.fromDate(range.endDate) || range.endDate)
        .where("endDate", ">", admin.firestore.Timestamp?.fromDate(range.startDate) || range.startDate)
        .where("status", "in", ACTIVE_BOOKING_STATUSES);
      const activeOverlapSnap = await transaction.get(activeOverlapQuery);

      assertNoActiveOverlap(activeOverlapSnap);

      const tokenData = buildTokenUpdateData({
        bookingId,
        renterId,
        assetId,
        endDate: booking.endDate,
        existingTokens: booking.tokens,
      });

      const now = admin.firestore?.FieldValue?.serverTimestamp() || new Date();
      const updatedBooking = {
        ...booking,
        status: BOOKING_STATUS.confirmed,
        tokens: tokenData.tokens,
        lastUpdated: now,
      };

      transaction.update(rootBookingRef, {
        status: BOOKING_STATUS.confirmed,
        tokens: tokenData.tokens,
        lastUpdated: now,
      });
      transaction.set(selectedBookingRef, buildBookingMirrorUpdate(updatedBooking), { merge: true });
      transaction.set(userBookingRef, buildBookingMirrorUpdate(updatedBooking), { merge: true });
      const event = {
        type: "confirmed",
        actorId: context.auth.uid,
        fromStatus: BOOKING_STATUS.pending,
        toStatus: BOOKING_STATUS.confirmed,
        createdAt: now,
      };
      transaction.set(rootBookingRef.collection("events").doc("confirmed"), event, { merge: true });
      transaction.set(selectedBookingRef.collection("events").doc("confirmed"), event, { merge: true });
      transaction.set(userBookingRef.collection("events").doc("confirmed"), event, { merge: true });

      if (ownerId) {
        transaction.set(
          ownerAssetMirrorRef,
          {
            pendingBookingCount: pendingBookingCountIncrementValue({
              fieldValue: admin.firestore.FieldValue,
              currentValue: ownerAssetMirrorSnap.data()?.pendingBookingCount,
              delta: -1,
            }),
          },
          { merge: true },
        );
      }

      // --- SEND CONFIRMATION MESSAGE (Critical UX feature) ---
      // Notify renter that booking was confirmed
      const chatId = booking.chatId;
      if (chatId) {
        const messageId = getLifecycleMessageId("confirmed", bookingId);
        const messageRef = db.collection("chats").doc(chatId).collection("messages").doc(messageId);

        const messageText = formatBookingPurpose(booking, "was confirmed.", "A booking");

        transaction.set(messageRef, {
          id: messageId,
          text: messageText,
          senderId: "", // System message
          createdAt: admin.firestore?.FieldValue?.serverTimestamp() || new Date(),
          type: "system",
          visibleTo: [renterId, booking.asset?.owner?.uid].filter(Boolean),
        });

        // Update userChats metadata with last message (for both renter and owner)
        const renterUserChatRef = db.collection("userChats").doc(renterId).collection("chats").doc(chatId);

        transaction.update(renterUserChatRef, {
          bookingStatus: BOOKING_STATUS.confirmed,
          hasRead: false,
          lastMessage: messageText,
          lastMessageDate: admin.firestore?.FieldValue?.serverTimestamp() || new Date(),
          lastMessageSenderId: "", // System message indicator
        });

        const ownerUserChatRef = db
          .collection("userChats")
          .doc(booking.asset?.owner?.uid)
          .collection("chats")
          .doc(chatId);

        transaction.update(ownerUserChatRef, {
          bookingStatus: BOOKING_STATUS.confirmed,
          hasRead: false,
          lastMessage: messageText,
          lastMessageDate: admin.firestore?.FieldValue?.serverTimestamp() || new Date(),
          lastMessageSenderId: "", // System message indicator
        });
      }

      return {
        success: true,
        confirmed: bookingId,
        booking: updatedBooking,
        startDate: booking.startDate,
        endDate: booking.endDate,
        messagesSent: !!chatId,
        renterId,
        ownerId,
        chatId,
        assetId,
        assetTitle: booking.asset?.title,
        tokens: tokenData.rawTokens,
        expiries: tokenData.expiries,
      };
    });

    console.log(`[confirmBooking PHASE 1] Booking ${bookingId} confirmed successfully`);
    await sendBookingConfirmedEmails({
      booking: confirmResult.booking,
      ownerId: confirmResult.ownerId,
      renterId: confirmResult.renterId,
    });

    // --- PHASE 2: ENQUEUE CLOUD TASKS (Decline overlapping bookings asynchronously) ---
    // This is best-effort; if it fails, selected booking is still confirmed
    try {
      // await enqueueDeclineTask({
      //   assetId,
      //   selectedBookingId: bookingId,
      //   startDate: confirmResult.startDate,
      //   endDate: confirmResult.endDate,
      // });

      // console.log(`[confirmBooking PHASE 2] Enqueued decline task for overlapping bookings`);
      return {
        success: true,
        message: `Booking ${bookingId} confirmed`,
        phase1: "completed",
        phase2: "none",
        tokens: confirmResult.tokens,
        expiries: confirmResult.expiries,
      };
    } catch (enqueueError) {
      console.warn(
        `[confirmBooking] Failed to enqueue decline task: ${enqueueError.message}. Overlapping bookings will be declined manually or on next sync.`,
      );
      return {
        success: true,
        message: `Booking ${bookingId} confirmed`,
        phase1: "completed",
        phase2: "enqueue_failed",
        warning: enqueueError.message,
        tokens: confirmResult.tokens,
        expiries: confirmResult.expiries,
      };
    }
  } catch (error) {
    console.error(`[confirmBooking] Error: ${error.message}`);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throwAndLogHttpsError("internal", error.message);
  }
};

/**
 * Helper: Enqueue Cloud Task to decline overlapping bookings
 *
 * Sends task to Cloud Tasks queue for async processing.
 * If queue doesn't exist or API fails, logs warning and continues.
 */
async function enqueueDeclineTask({ assetId, selectedBookingId, startDate, endDate }) {
  try {
    const cloudTasks = require("@google-cloud/tasks");
    const client = new cloudTasks.CloudTasksClient();

    const project = resolveProjectId();
    const queue = "decline-overlapping-bookings";
    const location = PRIMARY_FUNCTIONS_REGION;
    const url = getDeclineOverlappingBookingsUrl({ projectId: project });

    const parent = client.queuePath(project, location, queue);
    const task = buildDeclineTask({
      assetId,
      selectedBookingId,
      startDate,
      endDate,
      project,
      url,
      includeOidcToken: !isFunctionsEmulator(),
    });

    const request = { parent, task };
    const [response] = await client.createTask(request);

    console.log(`[enqueueDeclineTask] Created task: ${response.name}`);
    return response;
  } catch (error) {
    // If Cloud Tasks is not available, that's ok - just warn
    console.warn(`[enqueueDeclineTask] Could not enqueue task: ${error.message}`);
    throw error;
  }
}

function buildDeclineTask({ assetId, selectedBookingId, startDate, endDate, project, url, includeOidcToken = true }) {
  const httpRequest = {
    httpMethod: "POST",
    url,
    headers: {
      "Content-Type": "application/json",
    },
    body: Buffer.from(
      JSON.stringify({
        assetId,
        selectedBookingId,
        startDate: startDate?.toMillis?.() || startDate,
        endDate: endDate?.toMillis?.() || endDate,
      }),
    ).toString("base64"),
  };

  if (includeOidcToken) {
    httpRequest.oidcToken = {
      serviceAccountEmail: getTaskServiceAccountEmail(project),
      audience: url,
    };
  }

  return { httpRequest };
}

function assertNoActiveOverlap(activeOverlapSnap) {
  if (!activeOverlapSnap.empty) {
    throwAndLogHttpsError(
      "failed-precondition",
      "This booking overlaps an active booking and can no longer be accepted",
    );
  }
}

exports._test = {
  assertNoActiveOverlap,
  buildDeclineTask,
};
