const {
  admin,
  finalizeBookingSettlement,
  getDepositAmount,
  markOutstandingDamageRequired,
  normalizeNonNegativeAmount,
  normalizeOptionalText,
  throwAndLogHttpsError,
} = require("./utils/paymentFlow.util");

async function adminSettleDepositDispute(request) {
  const auth = request.auth;
  const { bookingId, approvedAmount, adminNotes } = request.data || {};
  if (!auth?.token?.admin) throwAndLogHttpsError("permission-denied", "Only admins can settle deposit disputes");
  if (!bookingId) throwAndLogHttpsError("invalid-argument", "Missing bookingId");
  const snap = await admin.firestore().collection("bookings").doc(bookingId).get();
  if (!snap.exists) throwAndLogHttpsError("not-found", "Booking not found");
  const booking = snap.data();
  if (!booking.disputeFlow) throwAndLogHttpsError("failed-precondition", "Booking has no dispute flow");
  const amount = normalizeNonNegativeAmount(approvedAmount, "approved amount");
  const depositAmount = getDepositAmount(booking);
  const depositCovered = Math.min(amount, depositAmount);
  const outstandingAmount = Math.max(amount - depositAmount, 0);
  if (outstandingAmount > 0) {
    return markOutstandingDamageRequired({ booking, actorId: auth.uid, approvedAmount: amount, depositCovered, outstandingAmount, adminNotes });
  }
  return finalizeBookingSettlement({
    booking,
    actorId: auth.uid,
    decision: "admin_settled",
    approvedDeductionAmount: amount,
    depositCoveredAmount: depositCovered,
    depositReturnAmount: Math.max(depositAmount - depositCovered, 0),
    paidOutstandingAmount: 0,
    adminNotes: normalizeOptionalText(adminNotes, 1000),
  });
}

module.exports = { adminSettleDepositDispute };
