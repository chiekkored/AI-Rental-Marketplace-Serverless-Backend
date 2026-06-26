const {
  throwAndLogHttpsError,
  userPaymentProfileRef,
} = require("./utils/paymentFlow.util");

async function getPaymentDestinations(request) {
  const auth = request.auth;
  if (!auth) throwAndLogHttpsError("permission-denied", "User must be authenticated");
  const snap = await userPaymentProfileRef(auth.uid).get();
  return {
    success: true,
    payoutDestination: snap.data()?.payoutDestination || null,
    depositReturnDestination: snap.data()?.depositReturnDestination || null,
  };
}

module.exports = { getPaymentDestinations };
