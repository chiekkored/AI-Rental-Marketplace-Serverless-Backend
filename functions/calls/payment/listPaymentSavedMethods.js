const {
  listCustomerPaymentMethods,
  throwAndLogHttpsError,
  toSavedPaymentMethod,
  userPaymentProfileRef,
} = require("./utils/paymentFlow.util");

async function listPaymentSavedMethods(request) {
  const auth = request.auth;
  if (!auth) throwAndLogHttpsError("permission-denied", "User must be authenticated");
  const profileSnap = await userPaymentProfileRef(auth.uid).get();
  const customerId = profileSnap.data()?.paymongoCustomerId;
  if (!customerId) return { success: true, paymentMethods: [] };
  const result = await listCustomerPaymentMethods(customerId);
  return { success: true, paymentMethods: (result?.data || []).map(toSavedPaymentMethod) };
}

module.exports = { listPaymentSavedMethods };
