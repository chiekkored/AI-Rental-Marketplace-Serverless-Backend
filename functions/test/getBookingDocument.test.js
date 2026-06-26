const assert = require("node:assert/strict");
const test = require("node:test");

const { BOOKING_STATUS } = require("../utils/booking.util");
const { _test } = require("../calls/getBookingDocument");

test("buildDocumentNumber creates role-specific stable prefixes", () => {
  assert.equal(_test.buildDocumentNumber("receipt", "booking-123456"), "LR-BOOKING-");
  assert.equal(_test.buildDocumentNumber("earnings", "booking-123456"), "LE-BOOKING-");
});

test("receipt is available only after a paid payment flow", () => {
  assert.doesNotThrow(() =>
    _test.assertDocumentAvailable({
      documentType: "receipt",
      booking: {
        paymentFlow: { status: "paid", amount: 1200 },
      },
    }),
  );

  assert.throws(
    () =>
      _test.assertDocumentAvailable({
        documentType: "receipt",
        booking: { paymentFlow: { status: "processing", amount: 1200 } },
      }),
    /Receipt is available after payment succeeds/,
  );
});

test("earnings are available only after completion with payout context", () => {
  assert.doesNotThrow(() =>
    _test.assertDocumentAvailable({
      documentType: "earnings",
      booking: {
        status: BOOKING_STATUS.completed,
        payoutFlow: { ownerPayoutAmount: 900 },
      },
    }),
  );

  assert.throws(
    () =>
      _test.assertDocumentAvailable({
        documentType: "earnings",
        booking: {
          status: BOOKING_STATUS.confirmed,
          payoutFlow: { ownerPayoutAmount: 900 },
        },
      }),
    /Earnings are available after the booking is completed/,
  );
});

test("VAT estimate extracts included VAT from fee total", () => {
  assert.equal(_test.estimateVatIncluded(112, 1200), 12);
  assert.equal(_test.estimateVatIncluded(0, 1200), 0);
  assert.equal(_test.estimateVatIncluded(100, 0), 0);
});

test("payment method formats card suffix and bank code", () => {
  assert.equal(
    _test.formatPaymentMethod({
      method: "card",
      methodDetails: { last4: "4242" },
    }),
    "Card ending in 4242",
  );
  assert.equal(
    _test.formatPaymentMethod({
      method: "dob",
      methodDetails: { bank_code: "ubp" },
    }),
    "Dob (UBP)",
  );
});

test("amount formatting uses readable currency codes and removes leading sign markers", () => {
  const booking = { paymentFlow: { currency: "PHP" } };

  assert.equal(_test.stripAmountSign("± PHP 1,234.50"), "PHP 1,234.50");
  assert.equal(_test.stripAmountSign("+ PHP 1,234.50"), "PHP 1,234.50");
  assert.equal(_test.stripAmountSign("- PHP 1,234.50"), "PHP 1,234.50");
  assert.equal(_test.formatMoney(-1234.5, booking), "PHP 1,234.50");
  assert.equal(_test.formatMoney(1234.5, booking), "PHP 1,234.50");
});

test("document file names are role-specific and filesystem-safe", () => {
  assert.equal(_test.buildDocumentFileName("receipt", "booking-123"), "lend-receipt-booking-123.pdf");
  assert.equal(_test.buildDocumentFileName("earnings", "booking/123"), "lend-earnings-booking123.pdf");
  assert.equal(_test.buildDocumentFileName("receipt", ""), "lend-receipt-booking.pdf");
});

test("first listing image prefers images and falls back to showcase", () => {
  assert.equal(
    _test.firstListingImageRef({
      images: ["", " https://cdn.example.com/photo.jpg "],
      showcase: ["https://cdn.example.com/showcase.png"],
    }),
    "https://cdn.example.com/photo.jpg",
  );
  assert.equal(
    _test.firstListingImageRef({
      images: [],
      showcase: ["listings/asset-1/images/showcase.png"],
    }),
    "listings/asset-1/images/showcase.png",
  );
  assert.equal(_test.firstListingImageRef({ images: [], showcase: [] }), null);
});

test("listing image support is limited to JPEG and PNG", () => {
  assert.equal(_test.isSupportedListingImageRef("listings/asset/images/photo.jpg"), true);
  assert.equal(_test.isSupportedListingImageRef("listings/asset/images/photo.jpeg"), true);
  assert.equal(_test.isSupportedListingImageRef("listings/asset/images/photo.png"), true);
  assert.equal(
    _test.isSupportedListingImageRef(
      "https://firebasestorage.googleapis.com/v0/b/bucket/o/listings%2Fasset%2Fimages%2Fphoto.png?alt=media&token=abc",
    ),
    true,
  );
  assert.equal(_test.isSupportedListingImageRef("listings/asset/images/photo.webp"), false);
  assert.equal(_test.isSupportedListingImageRef(null), false);
});

test("receipt PDF generation produces a PDF buffer", async () => {
  const buffer = await _test.buildBookingDocumentPdf({
    documentType: "receipt",
    documentNumber: "LR-BOOKING1",
    booking: {
      id: "booking-1",
      startDate: "2026-06-16",
      endDate: "2026-06-17",
      numDays: 1,
      status: BOOKING_STATUS.confirmed,
      asset: {
        title: "Professional Camera Kit",
        categoryName: "Photography",
        images: ["listings/asset-1/images/photo.webp"],
        owner: { firstName: "Owner", lastName: "User" },
        rates: { currency: "PHP" },
      },
      renter: { firstName: "Renter", lastName: "User" },
      priceBreakdown: {
        rentalSubtotal: 1000,
        securityDepositAmount: 500,
        renterPlatformFee: 50,
        renterProcessingFee: 25,
        paymentAmount: 1575,
        paymentMethod: { vatRateBps: 1200 },
      },
      paymentFlow: {
        status: "paid",
        amount: 1575,
        method: "card",
        transactionId: "txn-1",
        checkoutId: "checkout-1",
      },
    },
  });

  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 4).toString(), "%PDF");
});
