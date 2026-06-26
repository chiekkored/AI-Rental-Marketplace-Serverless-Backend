const assert = require("node:assert/strict");
const test = require("node:test");

const {
  bookingFinancialContribution,
  booleanDelta,
  isActiveBooking,
  isActiveListing,
  isPendingCancellation,
  isPendingDamage,
  isPendingReport,
  isPendingStatus,
  isPendingVerification,
  monthKeyForDate,
} = require("../utils/adminDashboardMetrics.util");

test("dashboard month keys use Asia/Manila calendar boundaries", () => {
  assert.equal(monthKeyForDate(new Date("2026-05-31T15:59:59.000Z")), "2026-05");
  assert.equal(monthKeyForDate(new Date("2026-05-31T16:00:00.000Z")), "2026-06");
});

test("dashboard revenue includes Lend fees and excludes deposits and provider costs", () => {
  const contribution = bookingFinancialContribution({
    asset: { categoryName: "Cameras" },
    paymentFlow: {
      paidAt: new Date("2026-06-10T04:00:00.000Z"),
      status: "paid",
    },
    priceBreakdown: {
      ownerPayoutTransferFee: 15,
      ownerPayoutTransferMarkupFee: 5,
      ownerPayoutTransferProviderFee: 10,
      paymentAmount: 1234.56,
      renterDepositReturnTransferFee: 15,
      renterDepositReturnTransferMarkupFee: 5,
      renterDepositReturnTransferProviderFee: 10,
      renterPlatformFee: 50,
      renterProcessingFee: 34.56,
      rentalSubtotal: 1000,
      securityDepositAmount: 150,
      securityDepositCollectionProcessingFee: 20,
    },
  });

  assert.deepEqual(contribution, {
    bookingCount: 1,
    categoryName: "Cameras",
    grossPaymentVolume: 1234.56,
    monthKey: "2026-06",
    netLendRevenue: 60,
    rentalGmv: 1000,
  });
});

test("dashboard revenue applies explicit refunds and chargeback adjustments", () => {
  const contribution = bookingFinancialContribution({
    paymentFlow: {
      chargebackAdjustment: 3,
      paidAt: new Date("2026-06-10T04:00:00.000Z"),
      refundedPlatformFee: 7,
      transactionId: "payment-1",
    },
    payoutFlow: {
      ownerPenaltyDeductionAmount: 20,
      ownerPayoutTransferMarkupFee: 5,
    },
    priceBreakdown: {
      paymentAmount: 500,
      renterPlatformFee: 50,
      rentalSubtotal: 400,
    },
  });

  assert.equal(contribution.netLendRevenue, 65);
});

test("dashboard workflow predicates produce reversible counter deltas", () => {
  assert.equal(isActiveBooking({ status: "Confirmed" }), true);
  assert.equal(isActiveListing({ isDeleted: false, status: "Available" }), true);
  assert.equal(isPendingCancellation({ cancellationRequest: { status: "pending" } }), true);
  assert.equal(isPendingDamage({ disputeFlow: { status: "under_review" } }), true);
  assert.equal(isPendingReport({ status: "resolved" }), false);
  assert.equal(isPendingStatus({ status: "pending" }), true);
  assert.equal(isPendingVerification({ fullVerification: { status: "pending" } }), true);
  assert.equal(booleanDelta({ status: "Pending" }, { status: "Confirmed" }, isActiveBooking), 1);
  assert.equal(booleanDelta({ status: "Confirmed" }, { status: "Completed" }, isActiveBooking), -1);
});
