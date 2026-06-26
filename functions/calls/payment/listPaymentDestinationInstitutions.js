const {
  buildProviderPayoutInstitutionLists,
  listReceivingInstitutions,
  normalizePayMongoError,
  throwAndLogHttpsError,
} = require("./utils/paymentFlow.util");

async function listPaymentDestinationInstitutions(request) {
  const auth = request.auth;
  if (!auth) throwAndLogHttpsError("permission-denied", "User must be authenticated");
  const destinationType = request.data?.destinationType === "ewallet" ? "ewallet" : "bank";
  const providerResults = await Promise.allSettled([listReceivingInstitutions("instapay"), listReceivingInstitutions("pesonet")]);
  const providerInstitutions = buildProviderPayoutInstitutionLists({
    instapayPayload: providerResults[0].status === "fulfilled" ? providerResults[0].value : null,
    pesonetPayload: providerResults[1].status === "fulfilled" ? providerResults[1].value : null,
    destinationType,
  });
  if (
    providerInstitutions.institutions.length === 0 &&
    providerInstitutions.instapayInstitutions.length === 0 &&
    providerInstitutions.pesonetInstitutions.length === 0
  ) {
    const rejected = providerResults.find((result) => result.status === "rejected");
    const normalized = normalizePayMongoError(rejected?.reason);
    throwAndLogHttpsError("internal", `Unable to load payout institutions: ${normalized.message}`, normalized);
  }
  return { success: true, ...providerInstitutions };
}

module.exports = { listPaymentDestinationInstitutions };
