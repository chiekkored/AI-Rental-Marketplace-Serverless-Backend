const {
  admin,
  finalizeBookingSettlement,
  getDepositAmount,
  throwAndLogHttpsError,
} = require("./utils/paymentFlow.util");

async function adminReleaseOutstandingDamageSettlement(request) {
  const auth = request.auth;
  const { bookingId } = request.data || {};
  if (!auth?.token?.admin) throwAndLogHttpsError("permission-denied", "Only admins can release this settlement");
  const snap = await admin.firestore().collection("bookings").doc(bookingId).get();
  if (!snap.exists) throwAndLogHttpsError("not-found", "Booking not found");
  const booking = snap.data();
  if (booking?.disputeFlow?.outstandingPaymentStatus !== "paid") {
    throwAndLogHttpsError("failed-precondition", "Outstanding damage payment is not paid");
  }
  const depositAmount = getDepositAmount(booking);
  const paidOutstanding = Number(booking.disputeFlow.paidOutstandingAmount || booking.disputeFlow.outstandingPayment?.amount || 0);
  const storedApprovedAmount = Number(booking.disputeFlow.approvedAmount ?? booking.settlement?.approvedDamageDeductionAmount);
  const approvedAmount = Number.isFinite(storedApprovedAmount) && storedApprovedAmount > 0
    ? storedApprovedAmount
    : depositAmount + paidOutstanding;
  const storedDepositCovered = Number(booking.disputeFlow.depositCoveredAmount ?? booking.settlement?.depositCoveredDamageAmount);
  const depositCovered = Number.isFinite(storedDepositCovered)
    ? Math.min(storedDepositCovered, depositAmount, approvedAmount)
    : Math.min(approvedAmount, depositAmount);
  return finalizeBookingSettlement({
    booking,
    actorId: auth.uid,
    decision: "admin_released_outstanding_damage",
    approvedDeductionAmount: approvedAmount,
    depositCoveredAmount: depositCovered,
    depositReturnAmount: Math.max(depositAmount - depositCovered, 0),
    paidOutstandingAmount: paidOutstanding,
    adminNotes: booking.disputeFlow.adminNotes || null,
  });
}

module.exports = { adminReleaseOutstandingDamageSettlement };
