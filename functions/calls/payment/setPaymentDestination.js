const {
  FieldValue,
  admin,
  normalizePayoutDestination,
  throwAndLogHttpsError,
  userPaymentProfileRef,
} = require("./utils/paymentFlow.util");

async function setPaymentDestination(request) {
  const auth = request.auth;
  const destinationKind = request.data?.destinationKind === "deposit_return" ? "deposit_return" : "owner_payout";
  if (!auth) throwAndLogHttpsError("permission-denied", "User must be authenticated");
  const userSnap = await admin.firestore().collection("users").doc(auth.uid).get();
  if (!userSnap.exists) throwAndLogHttpsError("not-found", "User not found");
  if (userSnap.data()?.verified !== "Full") {
    throwAndLogHttpsError("failed-precondition", "Full verification is required for this payment destination");
  }
  const payoutDestination = normalizePayoutDestination(request.data || {});
  const field = destinationKind === "deposit_return" ? "depositReturnDestination" : "payoutDestination";
  await userPaymentProfileRef(auth.uid).set(
    { [field]: payoutDestination, updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date() },
    { merge: true },
  );
  return {
    success: true,
    payoutDestination: destinationKind === "owner_payout" ? payoutDestination : null,
    depositReturnDestination: destinationKind === "deposit_return" ? payoutDestination : null,
  };
}

module.exports = { setPaymentDestination };
