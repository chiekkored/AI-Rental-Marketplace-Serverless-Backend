const {
  FieldValue,
  admin,
  normalizeOptionalText,
  throwAndLogHttpsError,
  writeBookingAndMirrors,
} = require("./utils/paymentFlow.util");

async function adminUpdateDisputeSupportRequest(request) {
  const auth = request.auth;
  const { bookingId, supportStatus, adminNotes } = request.data || {};
  if (!auth?.token?.admin) throwAndLogHttpsError("permission-denied", "Only admins can update support requests");
  if (!bookingId) throwAndLogHttpsError("invalid-argument", "Missing bookingId");
  const normalizedStatus = ["pending", "in_progress", "resolved", "closed"].includes(supportStatus)
    ? supportStatus
    : "pending";
  const db = admin.firestore();
  const bookingRef = db.collection("bookings").doc(bookingId);
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(bookingRef);
    if (!snap.exists) throwAndLogHttpsError("not-found", "Booking not found");
    const booking = snap.data();
    if (!booking.disputeFlow) throwAndLogHttpsError("failed-precondition", "Booking has no dispute context");
    const updatedBooking = {
      ...booking,
      disputeFlow: {
        ...booking.disputeFlow,
        supportStatus: normalizedStatus,
        adminNotes: normalizeOptionalText(adminNotes, 1000),
        updatedAt: now,
      },
      lastUpdated: now,
    };
    writeBookingAndMirrors(tx, updatedBooking);
  });
  return { success: true, status: "support_review", supportStatus: normalizedStatus };
}

module.exports = { adminUpdateDisputeSupportRequest };
