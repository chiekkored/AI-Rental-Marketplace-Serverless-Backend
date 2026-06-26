const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  DEFAULT_PRICING_POLICY,
  PRICING_POLICY_PARAMETER,
  normalizePricingPolicyConfig,
} = require("../utils/remoteConfig.util");

exports.getPricingPolicy = async (request) => {
  assertAdmin(request.auth);

  try {
    const template = await admin.remoteConfig().getTemplate();
    const raw = readPricingPolicy(template) || DEFAULT_PRICING_POLICY;
    const policy = toPublishedPricingPolicy(raw);
    normalizePricingPolicyConfig(policy);
    return {
      success: true,
      key: PRICING_POLICY_PARAMETER,
      policy,
      etag: template.etag || null,
    };
  } catch (error) {
    if (error?.code) throw error;
    throwAndLogHttpsError("internal", error.message || "Unable to load pricing policy");
  }
};

exports.updatePricingPolicy = async (request) => {
  assertAdmin(request.auth);
  const policy = request.data?.policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throwAndLogHttpsError("invalid-argument", "Missing pricing policy");
  }

  try {
    normalizePricingPolicyConfig(policy);
    const template = await admin.remoteConfig().getTemplate();
    const publishPolicy = toPublishedPricingPolicy(policy);
    template.parameters[PRICING_POLICY_PARAMETER] = {
      defaultValue: {
        value: JSON.stringify(publishPolicy),
      },
      description: "Lend checkout, settlement, and payment method fee policy.",
    };

    const updatedTemplate = await admin.remoteConfig().publishTemplate(template);
    return {
      success: true,
      key: PRICING_POLICY_PARAMETER,
      policy: publishPolicy,
      etag: updatedTemplate.etag || null,
    };
  } catch (error) {
    if (error?.code) throw error;
    throwAndLogHttpsError("invalid-argument", error.message || "Unable to update pricing policy");
  }
};

function assertAdmin(auth) {
  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }
  if (auth.token?.admin !== true) {
    throwAndLogHttpsError("permission-denied", "Only admins can manage pricing policy");
  }
}

function readPricingPolicy(template) {
  const parameter = template?.parameters?.[PRICING_POLICY_PARAMETER];
  const value =
    parameter?.defaultValue?.value ??
    parameter?.conditionalValues?.[Object.keys(parameter?.conditionalValues || {})[0]]?.value;
  if (!value || typeof value !== "string") return null;
  return JSON.parse(value);
}

function toPublishedPricingPolicy(policy) {
  return {
    ...policy,
    payment_method_fee_vat_rate_bps:
      policy.payment_method_fee_vat_rate_bps ?? DEFAULT_PRICING_POLICY.payment_method_fee_vat_rate_bps,
    renter_cancellation_policy:
      policy.renter_cancellation_policy ?? DEFAULT_PRICING_POLICY.renter_cancellation_policy,
    wallet_transfer_fee: toPublishedWalletTransferFee(
      policy.wallet_transfer_fee ?? DEFAULT_PRICING_POLICY.wallet_transfer_fee,
    ),
  };
}

function toPublishedWalletTransferFee(value) {
  if (value?.provider_fee || value?.lend_markup) {
    return {
      provider_fee:
        value.provider_fee ?? DEFAULT_PRICING_POLICY.wallet_transfer_fee.provider_fee,
      lend_markup:
        value.lend_markup ?? DEFAULT_PRICING_POLICY.wallet_transfer_fee.lend_markup,
    };
  }

  return {
    provider_fee: value,
    lend_markup: DEFAULT_PRICING_POLICY.wallet_transfer_fee.lend_markup,
  };
}

exports._test = {
  readPricingPolicy,
  toPublishedPricingPolicy,
  toPublishedWalletTransferFee,
};
