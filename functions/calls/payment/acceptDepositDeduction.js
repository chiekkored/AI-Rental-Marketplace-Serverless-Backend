const {
  DISPUTE_STATUS,
  admin,
  finalizeBookingSettlement,
  getBookingActors,
  getDepositAmount,
  throwAndLogHttpsError,
} = require("./utils/paymentFlow.util");

async function acceptDepositDeduction(request) {
  const auth = request.auth;
  const { bookingId } = request.data || {};
  if (!auth) throwAndLogHttpsError("permission-denied", "User must be authenticated");
  if (!bookingId) throwAndLogHttpsError("invalid-argument", "Missing bookingId");
  const snap = await admin.firestore().collection("bookings").doc(bookingId).get();
  if (!snap.exists) throwAndLogHttpsError("not-found", "Booking not found");
  const booking = snap.data();
  const { renterId } = getBookingActors(booking);
  if (auth.uid !== renterId) throwAndLogHttpsError("permission-denied", "Only the renter can accept this deduction");
  if (booking?.disputeFlow?.status !== DISPUTE_STATUS.requested) {
    throwAndLogHttpsError("failed-precondition", "Booking is not awaiting renter deposit response");
  }
  const depositAmount = getDepositAmount(booking);
  const approvedAmount = Number(booking.disputeFlow.requestedAmount || 0);
  const depositCovered = Math.min(approvedAmount, depositAmount);
  return finalizeBookingSettlement({
    booking,
    actorId: auth.uid,
    decision: "accepted_by_renter",
    approvedDeductionAmount: approvedAmount,
    depositCoveredAmount: depositCovered,
    depositReturnAmount: Math.max(depositAmount - depositCovered, 0),
    paidOutstandingAmount: 0,
  });
}

module.exports = { acceptDepositDeduction };
