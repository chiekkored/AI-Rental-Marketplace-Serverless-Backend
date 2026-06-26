const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_PRICING_POLICY,
  LISTING_REVIEW_BYPASS_AI_PARAMETER,
  MAINTENANCE_MODE_ENABLED_PARAMETER,
  PAYMENT_RECONCILIATION_ENABLED_PARAMETER,
  TRANSACTIONAL_EMAIL_ENABLED_PARAMETER,
  calculateFee,
  calculatePaymentMethodFee,
  normalizePricingPolicyConfig,
  parseRemoteConfigBooleanParameter,
  resolvePaymentMethodFee,
} = require("../utils/remoteConfig.util")._test;
const { buildBookingPriceBreakdown } = require("../calls/payment/utils/paymentFlow.util");

test("calculateFee supports all calculation modes", () => {
  assert.equal(calculateFee(10000, { rateBps: 250, fixedAmount: 0, calculation: "rate_only" }), 250);
  assert.equal(calculateFee(10000, { rateBps: 250, fixedAmount: 10, calculation: "fixed_only" }), 10);
  assert.equal(calculateFee(10000, { rateBps: 250, fixedAmount: 10, calculation: "rate_plus_fixed" }), 260);
  assert.equal(calculateFee(1000, { rateBps: 71, fixedAmount: 13.39, calculation: "max_rate_or_fixed" }), 13.39);
  assert.equal(calculateFee(100, { rateBps: 223, fixedAmount: 0, calculation: "rate_only" }), 2.23);
});

test("listing review AI bypass Remote Config defaults to false and accepts explicit true", () => {
  assert.equal(parseRemoteConfigBooleanParameter({}, LISTING_REVIEW_BYPASS_AI_PARAMETER, false), false);
  assert.equal(
    parseRemoteConfigBooleanParameter(
      {
        parameters: {
          [LISTING_REVIEW_BYPASS_AI_PARAMETER]: {
            defaultValue: { value: "true" },
          },
        },
      },
      LISTING_REVIEW_BYPASS_AI_PARAMETER,
      false,
    ),
    true,
  );
});

test("maintenance mode Remote Config defaults to false and accepts explicit true", () => {
  assert.equal(parseRemoteConfigBooleanParameter({}, MAINTENANCE_MODE_ENABLED_PARAMETER, false), false);
  assert.equal(
    parseRemoteConfigBooleanParameter(
      {
        parameters: {
          [MAINTENANCE_MODE_ENABLED_PARAMETER]: {
            defaultValue: { value: "true" },
          },
        },
      },
      MAINTENANCE_MODE_ENABLED_PARAMETER,
      false,
    ),
    true,
  );
});

test("payment reconciliation Remote Config defaults to false and accepts booleans", () => {
  assert.equal(parseRemoteConfigBooleanParameter({}, PAYMENT_RECONCILIATION_ENABLED_PARAMETER, false), false);
  assert.equal(
    parseRemoteConfigBooleanParameter(
      {
        parameters: {
          [PAYMENT_RECONCILIATION_ENABLED_PARAMETER]: {
            defaultValue: { value: "true" },
          },
        },
      },
      PAYMENT_RECONCILIATION_ENABLED_PARAMETER,
      false,
    ),
    true,
  );
  assert.equal(
    parseRemoteConfigBooleanParameter(
      {
        parameters: {
          [PAYMENT_RECONCILIATION_ENABLED_PARAMETER]: {
            defaultValue: { value: "false" },
          },
        },
      },
      PAYMENT_RECONCILIATION_ENABLED_PARAMETER,
      false,
    ),
    false,
  );
});

test("transactional email Remote Config defaults to true and accepts false", () => {
  assert.equal(parseRemoteConfigBooleanParameter({}, TRANSACTIONAL_EMAIL_ENABLED_PARAMETER, true), true);
  assert.equal(
    parseRemoteConfigBooleanParameter(
      {
        parameters: {
          [TRANSACTIONAL_EMAIL_ENABLED_PARAMETER]: {
            defaultValue: { value: "invalid" },
          },
        },
      },
      TRANSACTIONAL_EMAIL_ENABLED_PARAMETER,
      true,
    ),
    true,
  );
  assert.equal(
    parseRemoteConfigBooleanParameter(
      {
        parameters: {
          [TRANSACTIONAL_EMAIL_ENABLED_PARAMETER]: {
            defaultValue: { value: "false" },
          },
        },
      },
      TRANSACTIONAL_EMAIL_ENABLED_PARAMETER,
      true,
    ),
    false,
  );
});

test("normalizes method fee map and resolves wallet fee", () => {
  const policy = normalizePricingPolicyConfig(DEFAULT_PRICING_POLICY);
  const resolved = resolvePaymentMethodFee({
    policy,
    paymentMethod: "gcash",
  });

  assert.equal(resolved.label, "GCash");
  assert.equal(resolved.fee.rateBps, 223);
  assert.equal(calculateFee(10000, resolved.fee), 223);
  assert.equal(policy.renterCancellationPolicy.fullRefundWindow.leadTimeRateBps, 2500);
  assert.equal(policy.renterCancellationPolicy.fullRefundWindow.maxHours, 168);
  assert.equal(policy.renterCancellationPolicy.middleRetention.type, "percentage");
  assert.equal(policy.renterCancellationPolicy.middleRetention.rateBps, 5000);
});

test("renter cancellation policy supports fixed retention rules", () => {
  const input = structuredClone(DEFAULT_PRICING_POLICY);
  input.renter_cancellation_policy.middle_retention = {
    type: "fixed",
    fixed_amount: 250,
  };

  const policy = normalizePricingPolicyConfig(input);

  assert.equal(policy.renterCancellationPolicy.middleRetention.type, "fixed");
  assert.equal(policy.renterCancellationPolicy.middleRetention.fixedAmount, 250);
});

test("payment method fee estimates include configured VAT", () => {
  const policy = normalizePricingPolicyConfig(DEFAULT_PRICING_POLICY);
  const resolved = resolvePaymentMethodFee({
    policy,
    paymentMethod: "card",
  });

  assert.equal(policy.paymentMethodFeeVatRateBps, 1200);
  assert.equal(calculatePaymentMethodFee(200, resolved.fee, policy), 22);
});

test("card fee resolves international rule for non-PH payer country", () => {
  const policy = normalizePricingPolicyConfig(DEFAULT_PRICING_POLICY);
  const domestic = resolvePaymentMethodFee({
    policy,
    paymentMethod: "card",
    payerCountryShortName: "PH",
  });
  const missingCountry = resolvePaymentMethodFee({
    policy,
    paymentMethod: "card",
  });
  const international = resolvePaymentMethodFee({
    policy,
    paymentMethod: "card",
    payerCountryShortName: "sg",
  });
  const gcash = resolvePaymentMethodFee({
    policy,
    paymentMethod: "gcash",
    payerCountryShortName: "SG",
  });

  assert.equal(domestic.source, "card.domestic");
  assert.equal(calculateFee(10000, domestic.fee), 325.89);
  assert.equal(missingCountry.source, "card.domestic");
  assert.equal(calculateFee(10000, missingCountry.fee), 325.89);
  assert.equal(international.source, "card.international");
  assert.equal(calculateFee(10000, international.fee), 415.39);
  assert.equal(gcash.source, "gcash");
  assert.equal(calculateFee(10000, gcash.fee), 223);
});

test("resolves bank override or falls back to method default", () => {
  const input = structuredClone(DEFAULT_PRICING_POLICY);
  input.payment_method_fees.dob.banks.bpi = {
    label: "BPI",
    rate_bps: 50,
    fixed_amount: 20,
    calculation: "max_rate_or_fixed",
  };

  const policy = normalizePricingPolicyConfig(input);
  const bpi = resolvePaymentMethodFee({
    policy,
    paymentMethod: "dob",
    details: { bank_code: "bpi" },
  });
  const ubp = resolvePaymentMethodFee({
    policy,
    paymentMethod: "dob",
    details: { bank_code: "ubp" },
  });

  assert.equal(bpi.label, "BPI");
  assert.equal(bpi.fee.rateBps, 50);
  assert.equal(ubp.label, "Direct Online Banking");
  assert.equal(ubp.fee.rateBps, 71);
});

test("legacy renter_processing_fee remains usable during rollout", () => {
  const policy = normalizePricingPolicyConfig({
    checkout_lock_expiry_minutes_by_method: { default: 15 },
    owner_return_action_timeout_hours: 48,
    renter_processing_fee: { rate_bps: 100, fixed_amount: 0 },
    renter_cancellation_policy: DEFAULT_PRICING_POLICY.renter_cancellation_policy,
    platform_fee: { rate_bps: 0, fixed_amount: 0 },
    wallet_transfer_fee: { rate_bps: 0, fixed_amount: 10, calculation: "fixed_only" },
  });

  const resolved = resolvePaymentMethodFee({ policy, paymentMethod: "unknown_method" });
  assert.equal(calculateFee(10000, resolved.fee), 100);

  const card = resolvePaymentMethodFee({ policy, paymentMethod: "card" });
  assert.equal(calculateFee(10000, card.fee), 100);
});

test("legacy wallet transfer fee becomes provider cost with zero Lend markup", () => {
  const input = structuredClone(DEFAULT_PRICING_POLICY);
  input.wallet_transfer_fee = {
    rate_bps: 0,
    fixed_amount: 15,
    calculation: "fixed_only",
  };

  const policy = normalizePricingPolicyConfig(input);

  assert.equal(calculateFee(100, policy.fees.walletTransferProvider), 15);
  assert.equal(calculateFee(100, policy.fees.walletTransferMarkup), 0);
});

test("split wallet transfer fee keeps provider cost and Lend markup separate", () => {
  const input = structuredClone(DEFAULT_PRICING_POLICY);
  input.wallet_transfer_fee = {
    provider_fee: {
      rate_bps: 0,
      fixed_amount: 10,
      calculation: "fixed_only",
    },
    lend_markup: {
      rate_bps: 0,
      fixed_amount: 5,
      calculation: "fixed_only",
    },
  };

  const policy = normalizePricingPolicyConfig(input);
  const pricing = buildBookingPriceBreakdown({
    rentalSubtotal: 100,
    securityDeposit: { enabled: true, amount: 500 },
    policy,
    selectedPaymentMethod: "gcash",
    selectedPaymentMethodDetails: {},
    currency: "PHP",
  });

  assert.equal(pricing.ownerPayoutTransferProviderFee, 10);
  assert.equal(pricing.ownerPayoutTransferMarkupFee, 5);
  assert.equal(pricing.ownerPayoutTransferFee, 15);
  assert.equal(pricing.renterDepositReturnTransferProviderFee, 10);
  assert.equal(pricing.renterDepositReturnTransferMarkupFee, 5);
  assert.equal(pricing.renterDepositReturnTransferFee, 15);
});

test("checkout pricing applies international card fee to renter only", () => {
  const policy = normalizePricingPolicyConfig(DEFAULT_PRICING_POLICY);
  const pricing = buildBookingPriceBreakdown({
    rentalSubtotal: 10000,
    securityDeposit: { enabled: true, amount: 1000 },
    policy,
    selectedPaymentMethod: "card",
    selectedPaymentMethodDetails: {},
    payerCountryShortName: "SG",
    currency: "PHP",
  });

  assert.equal(pricing.paymentMethod.source, "card.international");
  assert.equal(pricing.renterProcessingFee, 465.24);
  assert.equal(pricing.securityDepositCollectionProcessingFee, 50);
  assert.equal(pricing.ownerProcessingFee, 70);
  assert.equal(pricing.paymentAmount, 11465.24);
});

test("checkout pricing adds platform fee to renter payment and deducts one wallet fee when no deposit is enabled", () => {
  const input = structuredClone(DEFAULT_PRICING_POLICY);
  input.platform_fee = {
    rate_bps: 0,
    fixed_amount: 5,
    calculation: "fixed_only",
  };
  const policy = normalizePricingPolicyConfig(input);
  const pricing = buildBookingPriceBreakdown({
    rentalSubtotal: 100,
    securityDeposit: { enabled: false, amount: 0 },
    policy,
    selectedPaymentMethod: "gcash",
    selectedPaymentMethodDetails: {},
    currency: "PHP",
  });

  assert.equal(pricing.renterPlatformFee, 5);
  assert.equal(pricing.renterProcessingFee, 2.62);
  assert.equal(pricing.ownerPayoutTransferFee, 10);
  assert.equal(pricing.renterDepositReturnTransferFee, 0);
  assert.equal(pricing.securityDepositCollectionProcessingFee, 0);
  assert.equal(pricing.ownerPayoutAmount, 90);
  assert.equal(pricing.paymentAmount, 107.62);
});

test("checkout pricing deducts owner-paid deposit payment fee and deposit return wallet fee from owner payout", () => {
  const input = structuredClone(DEFAULT_PRICING_POLICY);
  input.platform_fee = {
    rate_bps: 0,
    fixed_amount: 5,
    calculation: "fixed_only",
  };
  const policy = normalizePricingPolicyConfig(input);
  const pricing = buildBookingPriceBreakdown({
    rentalSubtotal: 100,
    securityDeposit: { enabled: true, amount: 500 },
    policy,
    selectedPaymentMethod: "gcash",
    selectedPaymentMethodDetails: {},
    currency: "PHP",
  });

  assert.equal(pricing.renterPlatformFee, 5);
  assert.equal(pricing.renterProcessingFee, 2.62);
  assert.equal(pricing.ownerPayoutTransferFee, 10);
  assert.equal(pricing.securityDepositCollectionProcessingFee, 12.49);
  assert.equal(pricing.renterDepositReturnTransferFee, 10);
  assert.equal(pricing.ownerPayoutAmount, 67.51);
  assert.equal(pricing.paymentAmount, 607.62);
});

test("checkout pricing calculates renter-paid platform fee from rental subtotal", () => {
  const input = structuredClone(DEFAULT_PRICING_POLICY);
  input.platform_fee = {
    rate_bps: 1000,
    fixed_amount: 0,
    calculation: "rate_only",
  };
  const policy = normalizePricingPolicyConfig(input);
  const pricing = buildBookingPriceBreakdown({
    rentalSubtotal: 200,
    securityDeposit: { enabled: true, amount: 500 },
    policy,
    selectedPaymentMethod: "gcash",
    selectedPaymentMethodDetails: {},
    currency: "PHP",
  });

  assert.equal(pricing.renterPlatformFee, 20);
  assert.equal(pricing.renterProcessingFee, 5.49);
  assert.equal(pricing.securityDepositCollectionProcessingFee, 12.49);
  assert.equal(pricing.renterDepositReturnTransferFee, 10);
  assert.equal(pricing.ownerPayoutAmount, 167.51);
  assert.equal(pricing.paymentAmount, 725.49);
});
