const {
  admin,
  assertReturnedAwaitingOwnerAction,
  finalizeBookingSettlement,
  getBookingActors,
  getDepositAmount,
  throwAndLogHttpsError,
} = require("./utils/paymentFlow.util");

async function completeReturnedBooking(request) {
  const auth = request.auth;
  const { bookingId } = request.data || {};
  if (!auth) throwAndLogHttpsError("permission-denied", "User must be authenticated");
  if (!bookingId) throwAndLogHttpsError("invalid-argument", "Missing bookingId");
  const snap = await admin.firestore().collection("bookings").doc(bookingId).get();
  if (!snap.exists) throwAndLogHttpsError("not-found", "Booking not found");
  const booking = snap.data();
  const { ownerId } = getBookingActors(booking);
  if (auth.uid !== ownerId) throwAndLogHttpsError("permission-denied", "Only the owner can complete this rental");
  assertReturnedAwaitingOwnerAction(booking);
  const depositAmount = getDepositAmount(booking);
  return finalizeBookingSettlement({
    booking,
    actorId: auth.uid,
    decision: "completed_by_owner",
    approvedDeductionAmount: 0,
    depositCoveredAmount: 0,
    depositReturnAmount: depositAmount,
    paidOutstandingAmount: 0,
  });
}

module.exports = { completeReturnedBooking };
