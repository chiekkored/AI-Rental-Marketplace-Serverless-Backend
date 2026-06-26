const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("./error.util");

const PAYMENT_METHODS_CONFIG_PATH = "appConfig/paymentMethods";

const PAYMENT_METHOD_CATALOG = {
  upfront: [
    { id: "card", method: "card", label: "Card" },
    { id: "gcash", method: "gcash", label: "GCash" },
    { id: "paymaya", method: "paymaya", label: "Maya" },
    { id: "grab_pay", method: "grab_pay", label: "GrabPay" },
    { id: "shopeepay", method: "shopeepay", label: "ShopeePay" },
    { id: "qrph", method: "qrph", label: "QR Ph" },
    { id: "bpi", method: "dob", bankCode: "bpi", label: "BPI" },
    { id: "ubp", method: "dob", bankCode: "ubp", label: "UnionBank" },
    { id: "bdo", method: "brankas", bankCode: "bdo", label: "BDO" },
    { id: "landbank", method: "brankas", bankCode: "landbank", label: "Landbank" },
    { id: "metrobank", method: "brankas", bankCode: "metrobank", label: "Metrobank" },
  ],
  subscription: [
    { id: "card", method: "card", label: "Card" },
    { id: "paymaya", method: "paymaya", label: "Maya" },
  ],
};

function defaultPaymentMethodsConfig() {
  return {
    upfrontMethods: defaultMethodStateMap(PAYMENT_METHOD_CATALOG.upfront),
    subscriptionMethods: defaultMethodStateMap(PAYMENT_METHOD_CATALOG.subscription),
  };
}

function defaultMethodStateMap(entries) {
  return Object.fromEntries(entries.map((entry) => [entry.id, { visible: true, enabled: true }]));
}

async function getPaymentMethodsConfig() {
  const snapshot = await admin.firestore().doc(PAYMENT_METHODS_CONFIG_PATH).get();
  return normalizePaymentMethodsConfig(snapshot.exists ? snapshot.data() : null);
}

function normalizePaymentMethodsConfig(data) {
  const defaults = defaultPaymentMethodsConfig();
  return {
    upfrontMethods: normalizeMethodStateMap(data?.upfrontMethods, defaults.upfrontMethods),
    subscriptionMethods: normalizeMethodStateMap(data?.subscriptionMethods, defaults.subscriptionMethods),
  };
}

function normalizeMethodStateMap(input, defaults) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return Object.fromEntries(
    Object.entries(defaults).map(([id, fallback]) => {
      const value = source[id];
      const state = value && typeof value === "object" && !Array.isArray(value) ? value : {};
      return [
        id,
        {
          visible: typeof state.visible === "boolean" ? state.visible : fallback.visible,
          enabled: typeof state.enabled === "boolean" ? state.enabled : fallback.enabled,
        },
      ];
    }),
  );
}

function resolvePaymentMethodConfigId({ paymentMethod, paymentMethodDetails }) {
  const method = typeof paymentMethod === "string" ? paymentMethod.trim() : "";
  const bankCode =
    typeof paymentMethodDetails?.bank_code === "string" ? paymentMethodDetails.bank_code.trim().toLowerCase() : "";
  if ((method === "dob" || method === "brankas") && bankCode) return bankCode;
  return method || "card";
}

function assertPaymentMethodAvailable({ config, mode, paymentMethod, paymentMethodDetails }) {
  const methods = mode === "subscription" ? config.subscriptionMethods : config.upfrontMethods;
  const id = resolvePaymentMethodConfigId({ paymentMethod, paymentMethodDetails });
  const state = methods[id];
  if (state?.visible === true && state?.enabled === true) return id;

  throwAndLogHttpsError("invalid-argument", "Selected payment method is not enabled");
}

function allowedPayMongoMethodsForMode(config, mode) {
  const catalog = mode === "subscription" ? PAYMENT_METHOD_CATALOG.subscription : PAYMENT_METHOD_CATALOG.upfront;
  const methods = mode === "subscription" ? config.subscriptionMethods : config.upfrontMethods;
  return Array.from(
    new Set(
      catalog
        .filter((entry) => methods[entry.id]?.visible === true && methods[entry.id]?.enabled === true)
        .map((entry) => entry.method),
    ),
  );
}

module.exports = {
  PAYMENT_METHOD_CATALOG,
  PAYMENT_METHODS_CONFIG_PATH,
  allowedPayMongoMethodsForMode,
  assertPaymentMethodAvailable,
  defaultPaymentMethodsConfig,
  getPaymentMethodsConfig,
  normalizePaymentMethodsConfig,
  resolvePaymentMethodConfigId,
};
