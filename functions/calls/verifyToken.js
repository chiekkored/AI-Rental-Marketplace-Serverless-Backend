const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const { validateSignedQrToken } = require("../utils/token.util");
const {
  assertQrScannerAuthorized,
  assertTokenActionAvailable,
  getExpectedTokenForAction,
} = require("../utils/booking.util");

/**
 * Verifies a QR token without altering any booking status.
 * - Checks token signature validity
 * - Ensures token is not expired
 * - Confirms booking exists and matches UUID
 */
exports.verifyToken = async (request) => {
  const auth = request.auth;
  const { token } = request.data || {};

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  const { payload, nowMs } = validateSignedQrToken({ token });
  const { bookingId, userId, assetId, action, uuid, expiresAt } = payload;

  // --- Check Firestore booking existence ---
  const assetBookingRef = admin.firestore().doc(`assets/${assetId}/bookings/${bookingId}`);
  const bookingSnap = await assetBookingRef.get();

  if (!bookingSnap.exists) {
    throwAndLogHttpsError("not-found", "Booking not found");
  }

  const booking = bookingSnap.data();
  assertQrScannerAuthorized({ authUid: auth.uid, action, booking });
  assertTokenActionAvailable(booking, action);

  const tokens = booking?.tokens;
  if (!tokens) {
    throwAndLogHttpsError("not-found", "No tokens found in booking");
  }

  // --- Compare Token ---
  const expectedToken = getExpectedTokenForAction(tokens, action);

  if (!expectedToken) {
    throwAndLogHttpsError("invalid-argument", "Invalid token action");
  }

  // Confirm the *entire* token matches the one in the database.
  // The 'token' variable is the full token string from request.data.
  if (expectedToken !== token) {
    throwAndLogHttpsError("permission-denied", "Token mismatch or outdated QR");
  }

  // --- Return valid token info ---
  return {
    //...
    valid: true,
    message: "QR token is valid",
    data: {
      bookingId,
      userId,
      assetId,
      action,
      expiresAt,
      remainingMs: expiresAt ? expiresAt - nowMs : null,
    },
  };
};
