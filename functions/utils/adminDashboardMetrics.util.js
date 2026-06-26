const DASHBOARD_TIME_ZONE = "Asia/Manila";
const ACTIVE_BOOKING_STATUSES = new Set([
  "confirmed",
  "handedover",
  "returned",
  "cancellation requested",
]);

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function monthKeyForDate(value) {
  const date = toDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    month: "2-digit",
    timeZone: DASHBOARD_TIME_ZONE,
    year: "numeric",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : null;
}

function monthLabel(monthKey) {
  if (!/^\d{4}-\d{2}$/.test(monthKey || "")) return monthKey || "";
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en", {
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function currentMonthKey(now = new Date()) {
  return monthKeyForDate(now);
}

function bookingFinancialContribution(booking) {
  if (!booking || !isPaidBooking(booking)) return null;

  const priceBreakdown = asRecord(booking.priceBreakdown) || asRecord(booking.payment?.pricingBreakdown) || {};
  const paymentFlow = asRecord(booking.paymentFlow) || {};
  const payment = asRecord(booking.payment) || {};
  const payoutFlow = asRecord(booking.payoutFlow) || {};
  const paidAt = paymentFlow.paidAt || payment.paidAt || booking.createdAt;
  const monthKey = monthKeyForDate(paidAt);
  if (!monthKey) return null;

  const ownerTransferMarkup = firstNumber([
    payoutFlow.ownerPayoutTransferMarkupFee,
    priceBreakdown.ownerPayoutTransferMarkupFee,
  ]);
  const depositReturnMarkup = firstNumber([
    payoutFlow.renterDepositReturnTransferMarkupFee,
    priceBreakdown.renterDepositReturnTransferMarkupFee,
  ]);
  const refundedPlatformFees = firstNumber([
    paymentFlow.refundedPlatformFee,
    payment.refundedPlatformFee,
    priceBreakdown.refundedPlatformFee,
  ]);
  const chargebackAdjustments = firstNumber([
    paymentFlow.chargebackAdjustment,
    payment.chargebackAdjustment,
    priceBreakdown.chargebackAdjustment,
  ]);

  return {
    bookingCount: 1,
    categoryName:
      cleanString(booking.asset?.categoryName) ||
      cleanString(booking.categoryName) ||
      "Uncategorized",
    grossPaymentVolume: roundCurrency(firstNumber([
      priceBreakdown.paymentAmount,
      paymentFlow.amount,
      payment.amount,
    ])),
    monthKey,
    netLendRevenue: roundCurrency(
      firstNumber([priceBreakdown.renterPlatformFee]) +
        ownerTransferMarkup +
        depositReturnMarkup +
        firstNumber([payoutFlow.ownerPenaltyDeductionAmount]) -
        refundedPlatformFees -
        chargebackAdjustments,
    ),
    rentalGmv: roundCurrency(firstNumber([
      priceBreakdown.rentalSubtotal,
      payment.rentalSubtotal,
      booking.totalPrice,
    ])),
  };
}

function isPaidBooking(booking) {
  const paymentFlow = asRecord(booking?.paymentFlow) || {};
  const payment = asRecord(booking?.payment) || {};
  const paymentStatus = cleanString(paymentFlow.status || payment.status)?.toLowerCase();
  return paymentStatus === "paid" || Boolean(paymentFlow.transactionId || payment.transactionId);
}

function isActiveBooking(booking) {
  return ACTIVE_BOOKING_STATUSES.has(cleanString(booking?.status)?.toLowerCase() || "");
}

function isPendingCancellation(booking) {
  return cleanString(booking?.cancellationRequest?.status)?.toLowerCase() === "pending";
}

function isPendingDamage(booking) {
  const dispute = asRecord(booking?.disputeFlow) || {};
  const deposit = asRecord(booking?.depositFlow) || {};
  const status = cleanString(dispute.status)?.toLowerCase() || "";
  const supportStatus = cleanString(dispute.supportStatus)?.toLowerCase() || "";
  const depositStatus = cleanString(deposit.status)?.toLowerCase() || "";
  if (!Object.keys(dispute).length) return false;
  if (status === "requested" || depositStatus === "awaiting_renter_response") return false;
  return !["resolved", "closed"].includes(status) && !["resolved", "closed"].includes(supportStatus);
}

function isActiveListing(listing) {
  return listing?.isDeleted !== true && cleanString(listing?.status)?.toLowerCase() === "available";
}

function isPendingReport(report) {
  return !["done", "resolved", "closed"].includes(cleanString(report?.status)?.toLowerCase() || "");
}

function isPendingVerification(user) {
  return cleanString(user?.fullVerification?.status)?.toLowerCase() === "pending";
}

function isPendingStatus(data) {
  return cleanString(data?.status)?.toLowerCase() === "pending";
}

function contributionDelta(before, after, field) {
  return roundCurrency(Number(after?.[field] || 0) - Number(before?.[field] || 0));
}

function booleanDelta(before, after, predicate) {
  return Number(predicate(after)) - Number(predicate(before));
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value._seconds === "number") return new Date(value._seconds * 1000);
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  return null;
}

function firstNumber(values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

module.exports = {
  ACTIVE_BOOKING_STATUSES,
  DASHBOARD_TIME_ZONE,
  bookingFinancialContribution,
  booleanDelta,
  contributionDelta,
  currentMonthKey,
  isActiveBooking,
  isActiveListing,
  isPaidBooking,
  isPendingCancellation,
  isPendingDamage,
  isPendingReport,
  isPendingStatus,
  isPendingVerification,
  monthKeyForDate,
  monthLabel,
  roundCurrency,
};
