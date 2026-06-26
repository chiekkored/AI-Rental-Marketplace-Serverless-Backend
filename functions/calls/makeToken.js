const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  getBookingRefs,
  assertBookingParticipant,
  assertTokenGenerationAllowed,
  assertCanonicalBookingRange,
  buildTokenUpdateData,
} = require("../utils/booking.util");
exports.makeToken = async (request) => {
  const auth = request.auth;
  const { userId, assetId, bookingId } = request.data;

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (!userId || !assetId || !bookingId) {
    throwAndLogHttpsError("invalid-argument", "Missing userId, assetId, or bookingId");
  }

  // Firestore references
  const { userBookingRef, assetBookingRef } = getBookingRefs({
    userId,
    renterId: userId,
    assetId,
    bookingId,
  });

  const bookingSnap = await assetBookingRef.get();

  if (!bookingSnap.exists) {
    throwAndLogHttpsError("not-found", "Booking not found");
  }

  const booking = bookingSnap.data();
  assertBookingParticipant(auth.uid, booking);
  assertTokenGenerationAllowed(booking);
  assertCanonicalBookingRange(booking);

  if (booking?.renter?.uid !== userId) {
    throwAndLogHttpsError("invalid-argument", "Booking renter does not match request");
  }

  const tokenData = buildTokenUpdateData({
    bookingId,
    renterId: userId,
    assetId,
    endDate: booking.endDate,
    existingTokens: booking.tokens,
  });

  // SAFE: Atomic transaction - both updates or neither
  await admin.firestore().runTransaction(async (transaction) => {
    // Verify both documents exist before updating
    const userBookingSnap = await transaction.get(userBookingRef);
    const assetBookingSnap = await transaction.get(assetBookingRef);

    if (!userBookingSnap.exists || !assetBookingSnap.exists) {
      throw new Error("Booking documents not found");
    }

    assertTokenGenerationAllowed(userBookingSnap.data());
    assertTokenGenerationAllowed(assetBookingSnap.data());

    // Update both atomically
    transaction.update(userBookingRef, { tokens: tokenData.tokens });
    transaction.update(assetBookingRef, { tokens: tokenData.tokens });
  });

  return {
    success: true,
    tokens: tokenData.rawTokens,
    expiries: tokenData.expiries,
  };
};
