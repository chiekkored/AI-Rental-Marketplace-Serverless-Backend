const assert = require("node:assert/strict");
const test = require("node:test");
const { _test: rendererTest } = require("../utils/emailTemplateRenderer.util");
const {
  buildBookingCancelledEmail,
  buildBookingConfirmedEmail,
  buildBookingRequestSubmittedEmail,
  buildEmailVerificationEmail,
  buildNewBookingRequestEmail,
  buildPaymentFailedEmail,
  buildPaymentReceiptEmail,
  buildPayoutEmail,
  buildRefundEmail,
  buildVerificationReviewEmail,
  canRevealOwnerName,
} = require("../utils/transactionalEmailTemplates.util");

const baseBooking = {
  id: "booking-123",
  status: "Pending",
  startDate: new Date("2026-06-20T00:00:00Z"),
  endDate: new Date("2026-06-22T00:00:00Z"),
  totalPrice: 2500,
  priceBreakdown: { currency: "PHP" },
  renter: { firstName: "Rina", lastName: "Santos" },
  asset: {
    title: "Mirrorless Camera <Pro>",
    owner: { displayName: "Secret Owner & Co" },
  },
};

test("all transactional templates include modern HTML and plain text", () => {
  const previousWebBaseUrl = process.env.LEND_WEB_BASE_URL;
  delete process.env.LEND_WEB_BASE_URL;

  try {
    const emails = [
      buildEmailVerificationEmail({ link: "https://getlend.dev/email/verify?token=abc", recipientName: "Rina Santos" }),
      buildBookingRequestSubmittedEmail({ booking: baseBooking, recipientName: "Rina" }),
      buildNewBookingRequestEmail({ booking: baseBooking, recipientName: "Owner" }),
      buildBookingConfirmedEmail({ booking: { ...baseBooking, status: "Confirmed" }, recipientName: "Rina", recipientRole: "renter" }),
      buildBookingCancelledEmail({ booking: baseBooking, recipientName: "Rina", recipientRole: "renter", refundStatus: "processing" }),
      buildPaymentReceiptEmail({ booking: { ...baseBooking, status: "Confirmed" }, recipientName: "Rina" }),
      buildPaymentFailedEmail({ booking: baseBooking, recipientName: "Rina" }),
      buildRefundEmail({ booking: { ...baseBooking, status: "Cancelled" }, recipientName: "Rina", refundStatus: "processed" }),
      buildPayoutEmail({ booking: { ...baseBooking, status: "Completed", payoutFlow: { amount: 2100 } }, payoutStatus: "paid", recipientName: "Owner" }),
      buildVerificationReviewEmail({ approved: false, recipientName: "Rina", submissionId: "submission-1" }),
    ];

    for (const email of emails) {
      assert.ok(email.subject);
      assert.match(email.html, /<!doctype html>/);
      assert.match(email.html, /<img src="[^"]+\/logo\.png" alt="Lend"/);
      assert.doesNotMatch(email.html, />Lend<\/span>/);
      assert.doesNotMatch(email.html, /This is an operational email from Lend/);
      assert.match(email.html, /You cannot reply to this email address/);
      assert.match(email.html, /<a href="https:\/\/getlend\.dev\/help-center"[^>]*>Help Center<\/a>/);
      assert.match(email.html, /<a href="https:\/\/getlend\.dev\/terms-and-conditions"[^>]*>Terms<\/a>/);
      assert.match(email.html, /<a href="https:\/\/getlend\.dev\/privacy-policy"[^>]*>Privacy<\/a>/);
      assert.match(email.html, /© 2026 Lend\. All rights reserved\./);
      assert.match(email.text, /You cannot reply to this email address/);
      assert.match(email.text, /https:\/\/getlend\.dev\/help-center/);
      assert.match(email.text, /Terms: https:\/\/getlend\.dev\/terms-and-conditions/);
      assert.match(email.text, /Privacy: https:\/\/getlend\.dev\/privacy-policy/);
      assert.ok(email.text.length > 40);
    }
  } finally {
    if (previousWebBaseUrl === undefined) {
      delete process.env.LEND_WEB_BASE_URL;
    } else {
      process.env.LEND_WEB_BASE_URL = previousWebBaseUrl;
    }
  }
});

test("email logo URL follows the configured web base URL", () => {
  assert.equal(rendererTest.buildLogoUrl({}), "https://getlend.dev/logo.png");
  assert.equal(rendererTest.buildWebUrl("/help-center", {}), "https://getlend.dev/help-center");
  assert.equal(
    rendererTest.buildLogoUrl({ LEND_WEB_BASE_URL: "http://127.0.0.1:3000/" }),
    "http://127.0.0.1:3000/logo.png",
  );
  assert.equal(
    rendererTest.buildWebUrl("/privacy-policy", { LEND_WEB_BASE_URL: "http://127.0.0.1:3000/" }),
    "http://127.0.0.1:3000/privacy-policy",
  );
});

test("booking template escapes dynamic HTML and includes app action", () => {
  const email = buildBookingRequestSubmittedEmail({ booking: baseBooking, recipientName: "<Rina> Admin" });
  assert.doesNotMatch(email.html, /Mirrorless Camera <Pro>/);
  assert.match(email.html, /Mirrorless Camera &lt;Pro&gt;/);
  assert.match(email.html, /&lt;Rina&gt;/);
  assert.match(email.html, /lend:\/\/booking\/booking-123/);
  assert.match(email.text, /2,500\.00/);
});

test("owner identity is disclosed only for active or completed statuses", () => {
  for (const status of ["Confirmed", "HandedOver", "Returned", "Completed"]) {
    assert.equal(canRevealOwnerName(status), true, status);
    const email = buildBookingConfirmedEmail({
      booking: { ...baseBooking, status },
      recipientName: "Rina",
      recipientRole: "renter",
    });
    assert.match(email.text, /Owner: Secret Owner & Co/);
  }

  for (const status of ["Pending", "Declined", "Cancelled", "Cancellation Requested", "", null, "Unknown"]) {
    assert.equal(canRevealOwnerName(status), false, String(status));
    const email = buildBookingCancelledEmail({
      booking: { ...baseBooking, status },
      recipientName: "Rina",
      recipientRole: "renter",
      status: status || "cancelled",
    });
    assert.doesNotMatch(email.text, /Secret Owner/);
    assert.doesNotMatch(email.html, /Secret Owner/);
  }
});

test("owner-facing request may identify the renter", () => {
  const email = buildNewBookingRequestEmail({ booking: baseBooking, recipientName: "Owner" });
  assert.match(email.text, /Renter: Rina Santos/);
});

test("cancelled outcome hides owner when the booking snapshot is stale", () => {
  const email = buildBookingCancelledEmail({
    booking: { ...baseBooking, status: "Confirmed" },
    recipientName: "Rina",
    recipientRole: "renter",
    status: "cancelled",
  });
  assert.doesNotMatch(email.text, /Secret Owner/);
  assert.doesNotMatch(email.html, /Secret Owner/);
});
