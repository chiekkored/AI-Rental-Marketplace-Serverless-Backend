const assert = require("node:assert/strict");
const test = require("node:test");

const {
  allowedPayMongoMethodsForMode,
  assertPaymentMethodAvailable,
  defaultPaymentMethodsConfig,
  normalizePaymentMethodsConfig,
  resolvePaymentMethodConfigId,
} = require("../utils/paymentMethodsConfig.util");

test("payment methods config defaults all current upfront methods and subscription card Maya to enabled", () => {
  const config = normalizePaymentMethodsConfig(null);

  assert.equal(config.upfrontMethods.card.visible, true);
  assert.equal(config.upfrontMethods.gcash.enabled, true);
  assert.equal(config.upfrontMethods.metrobank.visible, true);
  assert.equal(config.subscriptionMethods.card.enabled, true);
  assert.equal(config.subscriptionMethods.gcash, undefined);
  assert.equal(config.subscriptionMethods.paymaya.visible, true);
});

test("payment method config resolves bank-specific ids from PayMongo method details", () => {
  assert.equal(
    resolvePaymentMethodConfigId({
      paymentMethod: "dob",
      paymentMethodDetails: { bank_code: "BPI" },
    }),
    "bpi",
  );
  assert.equal(
    resolvePaymentMethodConfigId({
      paymentMethod: "brankas",
      paymentMethodDetails: { bank_code: "METROBANK" },
    }),
    "metrobank",
  );
});

test("payment method availability rejects hidden or disabled methods", () => {
  const config = defaultPaymentMethodsConfig();
  config.upfrontMethods.gcash.enabled = false;
  config.subscriptionMethods.paymaya.visible = false;

  assert.throws(
    () =>
      assertPaymentMethodAvailable({
        config,
        mode: "upfront",
        paymentMethod: "gcash",
        paymentMethodDetails: {},
      }),
    /Selected payment method is not enabled/,
  );
  assert.throws(
    () =>
      assertPaymentMethodAvailable({
        config,
        mode: "subscription",
        paymentMethod: "paymaya",
        paymentMethodDetails: {},
      }),
    /Selected payment method is not enabled/,
  );
});

test("allowed PayMongo method list is derived from visible enabled config entries", () => {
  const config = defaultPaymentMethodsConfig();
  config.upfrontMethods.bpi.enabled = false;
  config.upfrontMethods.ubp.visible = false;
  config.upfrontMethods.bdo.enabled = false;
  config.upfrontMethods.landbank.visible = false;
  config.upfrontMethods.metrobank.enabled = false;

  assert.deepEqual(allowedPayMongoMethodsForMode(config, "subscription"), ["card", "paymaya"]);
  assert.deepEqual(allowedPayMongoMethodsForMode(config, "upfront"), [
    "card",
    "gcash",
    "paymaya",
    "grab_pay",
    "shopeepay",
    "qrph",
  ]);
});
