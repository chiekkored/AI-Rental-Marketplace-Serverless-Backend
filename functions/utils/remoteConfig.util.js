const admin = require("firebase-admin");

const PRICING_POLICY_PARAMETER = "lend_pricing_policy";
const LISTING_REVIEW_BYPASS_AI_PARAMETER = "listing_review_bypass_ai";
const MAINTENANCE_MODE_ENABLED_PARAMETER = "lend_maintenance_mode_enabled";
const PAYMENT_RECONCILIATION_ENABLED_PARAMETER = "payment_reconciliation_enabled";
const TRANSACTIONAL_EMAIL_ENABLED_PARAMETER = "transactional_email_enabled";
const FEE_CALCULATION = {
  rateOnly: "rate_only",
  fixedOnly: "fixed_only",
  ratePlusFixed: "rate_plus_fixed",
  maxRateOrFixed: "max_rate_or_fixed",
};

const DEFAULT_PRICING_POLICY = {
  checkout_lock_expiry_minutes_by_method: {
    default: 15,
    card: 15,
    gcash: 30,
    paymaya: 30,
    grab_pay: 30,
    shopeepay: 30,
    qrph: 30,
    dob: 45,
    brankas: 45,
  },
  owner_return_action_timeout_hours: 48,
  payment_method_fee_vat_rate_bps: 1200,
  payment_method_fees: {
    card: {
      label: "Cards",
      domestic: { rate_bps: 312.5, fixed_amount: 13.39, calculation: FEE_CALCULATION.ratePlusFixed },
      international: { rate_bps: 402, fixed_amount: 13.39, calculation: FEE_CALCULATION.ratePlusFixed },
    },
    gcash: { label: "GCash", rate_bps: 223, fixed_amount: 0, calculation: FEE_CALCULATION.rateOnly },
    paymaya: { label: "Maya", rate_bps: 179, fixed_amount: 0, calculation: FEE_CALCULATION.rateOnly },
    grab_pay: { label: "GrabPay", rate_bps: 196, fixed_amount: 0, calculation: FEE_CALCULATION.rateOnly },
    shopeepay: { label: "ShopeePay", rate_bps: 170, fixed_amount: 0, calculation: FEE_CALCULATION.rateOnly },
    qrph: { label: "QR Ph", rate_bps: 134, fixed_amount: 0, calculation: FEE_CALCULATION.rateOnly },
    dob: {
      label: "Direct Online Banking",
      default: { rate_bps: 71, fixed_amount: 13.39, calculation: FEE_CALCULATION.maxRateOrFixed },
      banks: {},
    },
    brankas: {
      label: "Direct Online Banking",
      default: { rate_bps: 71, fixed_amount: 13.39, calculation: FEE_CALCULATION.maxRateOrFixed },
      banks: {},
    },
  },
  platform_fee: { rate_bps: 0, fixed_amount: 0, calculation: FEE_CALCULATION.ratePlusFixed },
  renter_cancellation_policy: {
    full_refund_window: { lead_time_rate_bps: 2500, max_hours: 168 },
    middle_retention: { type: "percentage", rate_bps: 5000, fixed_amount: 0 },
    no_refund_window: { lead_time_rate_bps: 1000, max_hours: 48 },
    no_refund_retention: { type: "percentage", rate_bps: 10000, fixed_amount: 0 },
  },
  wallet_transfer_fee: {
    provider_fee: { rate_bps: 0, fixed_amount: 10, calculation: FEE_CALCULATION.fixedOnly },
    lend_markup: { rate_bps: 0, fixed_amount: 0, calculation: FEE_CALCULATION.fixedOnly },
  },
};

function parseRemoteConfigJsonParameter(template, key) {
  const parameter = template?.parameters?.[key];
  const value =
    parameter?.defaultValue?.value ??
    parameter?.conditionalValues?.[Object.keys(parameter?.conditionalValues || {})[0]]?.value;

  if (!value || typeof value !== "string") {
    throw new Error(`Remote Config parameter ${key} is not configured`);
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Remote Config parameter ${key} must be valid JSON`);
  }
}

async function getPricingPolicyConfig() {
  const template = await admin.remoteConfig().getTemplate();
  return normalizePricingPolicyConfig(parseRemoteConfigJsonParameter(template, PRICING_POLICY_PARAMETER));
}

async function getListingReviewBypassAiConfig() {
  const template = await admin.remoteConfig().getTemplate();
  return parseRemoteConfigBooleanParameter(template, LISTING_REVIEW_BYPASS_AI_PARAMETER, false);
}

async function getMaintenanceModeEnabledConfig() {
  const template = await admin.remoteConfig().getTemplate();
  return parseRemoteConfigBooleanParameter(template, MAINTENANCE_MODE_ENABLED_PARAMETER, false);
}

async function getPaymentReconciliationEnabledConfig() {
  const template = await admin.remoteConfig().getTemplate();
  return parseRemoteConfigBooleanParameter(template, PAYMENT_RECONCILIATION_ENABLED_PARAMETER, false);
}

async function getTransactionalEmailEnabledConfig(adminClient = admin) {
  const template = await adminClient.remoteConfig().getTemplate();
  return parseRemoteConfigBooleanParameter(template, TRANSACTIONAL_EMAIL_ENABLED_PARAMETER, true);
}

function parseRemoteConfigBooleanParameter(template, key, defaultValue = false) {
  const parameter = template?.parameters?.[key];
  const value =
    parameter?.defaultValue?.value ??
    parameter?.conditionalValues?.[Object.keys(parameter?.conditionalValues || {})[0]]?.value;

  if (value === true) return true;
  if (value === false) return false;
  if (typeof value !== "string") return defaultValue;

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return defaultValue;
}

function normalizePricingPolicyConfig(input) {
  const source = input && typeof input === "object" ? input : {};
  const lockExpiryMinutesByMethod = normalizePositiveNumberMap(input?.checkout_lock_expiry_minutes_by_method, {
    fieldName: "checkout_lock_expiry_minutes_by_method",
  });
  const ownerReturnActionTimeoutHours = requireNonNegativeNumber(
    input?.owner_return_action_timeout_hours,
    "owner_return_action_timeout_hours",
  );

  return {
    checkoutLockExpiryMinutesByMethod: lockExpiryMinutesByMethod,
    ownerReturnActionTimeoutHours,
    paymentMethodFeeVatRateBps: requireNonNegativeNumber(
      source.payment_method_fee_vat_rate_bps ?? DEFAULT_PRICING_POLICY.payment_method_fee_vat_rate_bps,
      "payment_method_fee_vat_rate_bps",
    ),
    paymentMethodFees: normalizePaymentMethodFees(source.payment_method_fees, source.renter_processing_fee),
    renterCancellationPolicy: normalizeRenterCancellationPolicy(source.renter_cancellation_policy),
    fees: {
      renterProcessing: normalizeFee(
        source.renter_processing_fee || { rate_bps: 0, fixed_amount: 0, calculation: FEE_CALCULATION.ratePlusFixed },
        "renter_processing_fee",
      ),
      platform: normalizeFee(source.platform_fee, "platform_fee"),
      ...normalizeWalletTransferFee(source.wallet_transfer_fee),
    },
    raw: source,
  };
}

function normalizeWalletTransferFee(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Remote Config wallet_transfer_fee must be an object");
  }

  const usesSplitShape = input.provider_fee || input.lend_markup;
  const providerInput = usesSplitShape ? input.provider_fee : input;
  const markupInput = usesSplitShape
    ? input.lend_markup || { rate_bps: 0, fixed_amount: 0, calculation: FEE_CALCULATION.fixedOnly }
    : { rate_bps: 0, fixed_amount: 0, calculation: FEE_CALCULATION.fixedOnly };

  return {
    walletTransferProvider: normalizeFee(providerInput, "wallet_transfer_fee.provider_fee"),
    walletTransferMarkup: normalizeFee(markupInput, "wallet_transfer_fee.lend_markup"),
  };
}

function normalizeRenterCancellationPolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Remote Config renter_cancellation_policy must be an object");
  }

  return {
    fullRefundWindow: normalizeCancellationWindow(
      input.full_refund_window,
      "renter_cancellation_policy.full_refund_window",
    ),
    middleRetention: normalizeRetentionRule(
      input.middle_retention,
      "renter_cancellation_policy.middle_retention",
    ),
    noRefundWindow: normalizeCancellationWindow(
      input.no_refund_window,
      "renter_cancellation_policy.no_refund_window",
    ),
    noRefundRetention: normalizeRetentionRule(
      input.no_refund_retention,
      "renter_cancellation_policy.no_refund_retention",
    ),
  };
}

function normalizeCancellationWindow(input, fieldName) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Remote Config ${fieldName} must be an object`);
  }

  return {
    leadTimeRateBps: requireNonNegativeNumber(input.lead_time_rate_bps, `${fieldName}.lead_time_rate_bps`),
    maxHours: requireNonNegativeNumber(input.max_hours, `${fieldName}.max_hours`),
  };
}

function normalizeRetentionRule(input, fieldName) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Remote Config ${fieldName} must be an object`);
  }

  const type = typeof input.type === "string" ? input.type.trim() : "";
  if (type !== "percentage" && type !== "fixed") {
    throw new Error(`Remote Config ${fieldName}.type must be percentage or fixed`);
  }

  return {
    type,
    rateBps: requireNonNegativeNumber(input.rate_bps ?? 0, `${fieldName}.rate_bps`),
    fixedAmount: requireNonNegativeNumber(input.fixed_amount ?? 0, `${fieldName}.fixed_amount`),
  };
}

function normalizeFee(input, fieldName) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Remote Config ${fieldName} must be an object`);
  }

  return {
    rateBps: requireNonNegativeNumber(input.rate_bps, `${fieldName}.rate_bps`),
    fixedAmount: requireNonNegativeNumber(input.fixed_amount, `${fieldName}.fixed_amount`),
    calculation: normalizeCalculation(input.calculation, `${fieldName}.calculation`),
  };
}

function calculateFee(amount, fee) {
  const baseAmount = requireNonNegativeNumber(amount, "amount");
  const rateAmount = (baseAmount * (fee.rateBps || 0)) / 10000;
  const fixedAmount = Number(fee.fixedAmount || 0);
  switch (fee.calculation || FEE_CALCULATION.ratePlusFixed) {
    case FEE_CALCULATION.rateOnly:
      return rateAmount;
    case FEE_CALCULATION.fixedOnly:
      return fixedAmount;
    case FEE_CALCULATION.maxRateOrFixed:
      return Math.max(rateAmount, fixedAmount);
    case FEE_CALCULATION.ratePlusFixed:
    default:
      return rateAmount + fixedAmount;
  }
}

function calculatePaymentMethodFee(amount, fee, policy) {
  const baseFee = calculateFee(amount, fee);
  const vatRateBps = requireNonNegativeNumber(
    policy?.paymentMethodFeeVatRateBps ?? DEFAULT_PRICING_POLICY.payment_method_fee_vat_rate_bps,
    "payment_method_fee_vat_rate_bps",
  );
  return roundCurrency(baseFee * (1 + vatRateBps / 10000));
}

function roundCurrency(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function resolvePaymentMethodFee({ policy, paymentMethod, details = {}, payerCountryShortName = null }) {
  const methodKey = typeof paymentMethod === "string" && paymentMethod.trim() ? paymentMethod.trim() : "card";
  const methodConfig = policy?.paymentMethodFees?.[methodKey];
  if (!methodConfig) {
    return {
      method: methodKey,
      label: methodKey,
      fee: policy?.fees?.renterProcessing || { rateBps: 0, fixedAmount: 0, calculation: FEE_CALCULATION.ratePlusFixed },
      source: "legacy_renter_processing_fee",
    };
  }

  if (methodKey === "card") {
    const useInternational = usesInternationalCardFee(payerCountryShortName);
    return {
      method: methodKey,
      label: methodConfig.label,
      fee: useInternational ? methodConfig.international : methodConfig.domestic,
      source: useInternational ? "card.international" : "card.domestic",
    };
  }

  const bankCode = typeof details?.bank_code === "string" ? details.bank_code.trim().toLowerCase() : "";
  if ((methodKey === "dob" || methodKey === "brankas") && bankCode) {
    return {
      method: methodKey,
      bankCode,
      label: methodConfig.banks?.[bankCode]?.label || methodConfig.label,
      fee: methodConfig.banks?.[bankCode] || methodConfig.default,
      source: methodConfig.banks?.[bankCode] ? `${methodKey}.banks.${bankCode}` : `${methodKey}.default`,
    };
  }

  return {
    method: methodKey,
    label: methodConfig.label,
    fee: methodConfig,
    source: methodKey,
  };
}

function usesInternationalCardFee(payerCountryShortName) {
  const country =
    typeof payerCountryShortName === "string" ? payerCountryShortName.trim().toUpperCase() : "";
  return Boolean(country) && country !== "PH";
}

function resolveCheckoutLockExpiryMs({ paymentMethod, policy }) {
  const minutes =
    policy?.checkoutLockExpiryMinutesByMethod?.[paymentMethod] ??
    policy?.checkoutLockExpiryMinutesByMethod?.default;

  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`No checkout lock expiry configured for payment method ${paymentMethod}`);
  }

  return Math.round(minutes * 60 * 1000);
}

function normalizePositiveNumberMap(input, { fieldName }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Remote Config ${fieldName} must be an object`);
  }

  const result = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized <= 0) {
      throw new Error(`Remote Config ${fieldName}.${key} must be a positive number`);
    }
    result[key] = normalized;
  }

  if (!Object.keys(result).length) {
    throw new Error(`Remote Config ${fieldName} must not be empty`);
  }

  return result;
}

function requireNonNegativeNumber(value, fieldName) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`Remote Config ${fieldName} must be a non-negative number`);
  }
  return normalized;
}

function normalizePaymentMethodFees(input, legacyRenterProcessingFee) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const legacy = normalizeFee(legacyRenterProcessingFee, "renter_processing_fee");
    return {
      card: {
        label: "Cards",
        domestic: legacy,
        international: legacy,
      },
      gcash: { label: "GCash", ...legacy },
      paymaya: { label: "Maya", ...legacy },
      grab_pay: { label: "GrabPay", ...legacy },
      shopeepay: { label: "ShopeePay", ...legacy },
      qrph: { label: "QR Ph", ...legacy },
      dob: {
        label: "Direct Online Banking",
        default: legacy,
        banks: {},
      },
      brankas: {
        label: "Direct Online Banking",
        default: legacy,
        banks: {},
      },
    };
  }

  const result = {};
  for (const [key, config] of Object.entries(input)) {
    result[key] = normalizePaymentMethodConfig(config, `payment_method_fees.${key}`);
  }
  return result;
}

function normalizePaymentMethodConfig(input, fieldName) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Remote Config ${fieldName} must be an object`);
  }

  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim() : fieldName.split(".").pop();
  if (input.default || input.banks) {
    const banks = {};
    for (const [bankCode, bankFee] of Object.entries(input.banks || {})) {
      banks[bankCode] = {
        ...normalizeFee(bankFee, `${fieldName}.banks.${bankCode}`),
        label: typeof bankFee?.label === "string" && bankFee.label.trim() ? bankFee.label.trim() : bankCode,
      };
    }
    return {
      label,
      default: normalizeFee(input.default, `${fieldName}.default`),
      banks,
    };
  }

  if (input.domestic || input.international) {
    return {
      label,
      domestic: normalizeFee(input.domestic, `${fieldName}.domestic`),
      international: normalizeFee(input.international || input.domestic, `${fieldName}.international`),
    };
  }

  return {
    label,
    ...normalizeFee(input, fieldName),
  };
}

function normalizeCalculation(value, fieldName) {
  if (value == null || value === "") return FEE_CALCULATION.ratePlusFixed;
  if (Object.values(FEE_CALCULATION).includes(value)) return value;
  throw new Error(`Remote Config ${fieldName} has unsupported calculation mode`);
}

module.exports = {
  DEFAULT_PRICING_POLICY,
  FEE_CALCULATION,
  LISTING_REVIEW_BYPASS_AI_PARAMETER,
  MAINTENANCE_MODE_ENABLED_PARAMETER,
  PAYMENT_RECONCILIATION_ENABLED_PARAMETER,
  TRANSACTIONAL_EMAIL_ENABLED_PARAMETER,
  PRICING_POLICY_PARAMETER,
  calculateFee,
  calculatePaymentMethodFee,
  getListingReviewBypassAiConfig,
  getMaintenanceModeEnabledConfig,
  getPaymentReconciliationEnabledConfig,
  getTransactionalEmailEnabledConfig,
  getPricingPolicyConfig,
  normalizePricingPolicyConfig,
  normalizeRenterCancellationPolicy,
  resolvePaymentMethodFee,
  resolveCheckoutLockExpiryMs,
  _test: {
    DEFAULT_PRICING_POLICY,
    LISTING_REVIEW_BYPASS_AI_PARAMETER,
    MAINTENANCE_MODE_ENABLED_PARAMETER,
    PAYMENT_RECONCILIATION_ENABLED_PARAMETER,
    TRANSACTIONAL_EMAIL_ENABLED_PARAMETER,
    calculateFee,
    calculatePaymentMethodFee,
    normalizePricingPolicyConfig,
    normalizeRenterCancellationPolicy,
    normalizeWalletTransferFee,
    parseRemoteConfigBooleanParameter,
    parseRemoteConfigJsonParameter,
    resolvePaymentMethodFee,
    usesInternationalCardFee,
  },
};
