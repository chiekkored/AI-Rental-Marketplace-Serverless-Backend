const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { BOOKING_STATUS, CHAT_STATUS, normalizeBookingRange } = require("../utils/booking.util");
const { verifyCloudTaskRequest } = require("../utils/task.util");
const { pendingBookingCountIncrementValue } = require("../utils/pendingBookingCount.util");
const { FUNCTIONS_REGION } = require("../utils/functionsRegion.util");

/**
 * Cloud Function: Decline Overlapping Bookings (Cloud Tasks Handler)
 *
 * Called asynchronously by Cloud Tasks queue when a booking is confirmed.
 * Finds all pending bookings that overlap with confirmed booking
 * and declines them with best-effort retries.
 *
 * NOTE: This is HTTP-triggered (not callable) because it's invoked by Cloud Tasks.
 * Cloud Tasks provides automatic retries with exponential backoff.
 */
exports.declineOverlappingBookings = functions.https.onRequest({ region: FUNCTIONS_REGION }, async (request, response) => {
  if (request.method !== "POST") {
    return response.status(405).send("Method Not Allowed");
  }

  const db = admin.firestore();

  try {
    await verifyCloudTaskRequest(request);
  } catch (authError) {
    console.error(`[declineOverlappingBookings] Unauthorized request: ${authError.message}`);
    return response.status(401).send("Unauthorized");
  }

  let payload;
  try {
    payload = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
  } catch (parseError) {
    console.error(`[declineOverlappingBookings] Failed to parse Cloud Tasks payload: ${parseError.message}`);
    return response.status(400).send("Invalid payload");
  }

  let normalizedPayload;

  try {
    normalizedPayload = normalizeOverlapPayload(payload);
  } catch (payloadError) {
    console.error(`[declineOverlappingBookings] Invalid payload: ${payloadError.message}`);
    return response.status(400).send(payloadError.message);
  }

  try {
    const { assetId, selectedBookingId, range } = normalizedPayload;
    console.log(`[declineOverlappingBookings] Processing asset=${assetId}, skipping=${selectedBookingId}`);

    // Find all pending bookings that overlap with confirmed booking's date range
    const overlappingQuery = await db
      .collection("assets")
      .doc(assetId)
      .collection("bookings")
      .where("startDate", "<", admin.firestore.Timestamp?.fromDate(range.endDate) || range.endDate)
      .where("endDate", ">", admin.firestore.Timestamp?.fromDate(range.startDate) || range.startDate)
      .where("status", "==", BOOKING_STATUS.pending)
      .get();

    console.log(`[declineOverlappingBookings] Found ${overlappingQuery.docs.length} overlapping pending bookings`);

    const results = [];

    // Process each overlapping booking
    for (const doc of overlappingQuery.docs) {
      const bookingId = doc.id;
      const bookingData = doc.data();
      const renterId = bookingData.renter?.uid;

      // Skip the selected booking that was just confirmed
      if (bookingId === selectedBookingId) {
        console.log(`[declineOverlappingBookings] Skipping confirmed booking ${bookingId}`);
        results.push({ bookingId, status: "skipped_selected" });
        continue;
      }

      try {
        const result = await declineBooking({
          assetId,
          bookingId,
          renterId,
          ownerId: bookingData.asset?.owner?.uid,
          chatId: bookingData.chatId,
        });
        results.push(result);
      } catch (declineError) {
        console.error(`[declineOverlappingBookings] Failed to decline booking ${bookingId}: ${declineError.message}`);
        results.push({
          bookingId,
          status: "failed",
          error: declineError.message,
        });
        // Continue with next booking instead of failing entire task
      }
    }

    const summary = summarizeDeclineResults(results);

    console.log(
      `[declineOverlappingBookings] Completed: declined=${summary.declinedCount}, errors=${summary.errorCount}`,
    );

    // Return 200 to mark task as successful even if some declines failed
    return response.status(200).json({
      success: true,
      ...summary,
      results,
    });
  } catch (error) {
    console.error(`[declineOverlappingBookings] Error processing task: ${error.message}`);
    // Return 500 to trigger Cloud Tasks retry
    return response.status(500).send(`Error: ${error.message}`);
  }
});

/**
 * Helper: Decline a single booking
 *
 * Updates booking status to "Declined" in both collections
 * and updates chat status to "Archived"
 */
async function declineBooking({ assetId, bookingId, renterId, ownerId, chatId }) {
  const db = admin.firestore();

  if (!assetId || !bookingId || !renterId) {
    throw new Error("Missing assetId, bookingId, or renterId");
  }

  const batch = db.batch();
  const assetBookingRef = db.doc(`assets/${assetId}/bookings/${bookingId}`);
  const userBookingRef = db.doc(`users/${renterId}/bookings/${bookingId}`);
  const chatRef = chatId ? db.doc(`userChats/${renterId}/chats/${chatId}`) : null;
  const ownerAssetMirrorRef = ownerId ? db.doc(`users/${ownerId}/assets/${assetId}`) : null;
  const refsToRead = [assetBookingRef, userBookingRef];
  if (chatRef) {
    refsToRead.push(chatRef);
  }
  if (ownerAssetMirrorRef) {
    refsToRead.push(ownerAssetMirrorRef);
  }

  const snapsByPath = new Map((await db.getAll(...refsToRead)).map((snap) => [snap.ref.path, snap]));
  const assetBookingSnap = snapsByPath.get(assetBookingRef.path);
  const userBookingSnap = snapsByPath.get(userBookingRef.path);
  const chatSnap = chatRef ? snapsByPath.get(chatRef.path) : null;
  const ownerAssetMirrorSnap = ownerAssetMirrorRef ? snapsByPath.get(ownerAssetMirrorRef.path) : null;
  const now = admin.firestore?.FieldValue?.serverTimestamp() || new Date();
  const missing = [];

  if (!assetBookingSnap.exists) {
    throw new Error("Asset booking mirror missing");
  }

  batch.update(assetBookingRef, {
    status: BOOKING_STATUS.declined,
    lastUpdated: now,
  });

  if (userBookingSnap.exists) {
    batch.update(userBookingRef, {
      status: BOOKING_STATUS.declined,
      lastUpdated: now,
    });
  } else {
    missing.push("userBooking");
  }

  if (chatRef && chatSnap?.exists) {
    batch.update(chatRef, {
      bookingStatus: BOOKING_STATUS.declined,
      status: CHAT_STATUS.archived,
      lastUpdated: now,
    });
  } else if (chatRef) {
    missing.push("renterChat");
  } else {
    missing.push("chatId");
  }

  if (ownerAssetMirrorRef) {
    batch.set(
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

  await batch.commit();

  console.log(`[declineBooking] Declined booking ${bookingId}`);
  return {
    bookingId,
    status: missing.length > 0 ? "declined_with_missing_mirrors" : "declined",
    missing,
  };
}

function normalizeOverlapPayload(payload = {}) {
  const { assetId, selectedBookingId, startDate, endDate } = payload;

  if (!assetId || !selectedBookingId || !startDate || !endDate) {
    throw new Error("Missing required fields");
  }

  return {
    assetId,
    selectedBookingId,
    range: normalizeBookingRange({ startDate, endDate }),
  };
}

function summarizeDeclineResults(results) {
  return {
    declinedCount: results.filter(
      (result) => result.status === "declined" || result.status === "declined_with_missing_mirrors",
    ).length,
    skippedCount: results.filter((result) => result.status === "skipped_selected").length,
    missingMirrorCount: results.filter((result) => result.status === "declined_with_missing_mirrors").length,
    errorCount: results.filter((result) => result.status === "failed").length,
  };
}

exports._test = {
  normalizeOverlapPayload,
  summarizeDeclineResults,
};
