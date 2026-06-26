function normalizeCardBrand(brand) {
  const normalized = typeof brand === "string" ? brand.trim().toLowerCase().replace(/\s+/g, "") : "";
  if (normalized === "master" || normalized === "mastercard") return "mastercard";
  if (normalized === "visa") return "visa";
  return normalized;
}

function isRecurringPaymentMethodSupported({ paymentMethod, paymentMethodDetails }) {
  return typeof paymentMethod === "string" && paymentMethod.trim().length > 0;
}

function assertRecurringPaymentMethodSupported({ isRecurring, paymentMethod, paymentMethodDetails, throwError }) {
  if (!isRecurring) return;
  if (isRecurringPaymentMethodSupported({ paymentMethod, paymentMethodDetails })) return;
  throwError(
    "failed-precondition",
    "Selected payment method cannot be used for recurring bookings. Please choose an enabled subscription method.",
  );
}

module.exports = {
  assertRecurringPaymentMethodSupported,
  isRecurringPaymentMethodSupported,
  normalizeCardBrand,
};
