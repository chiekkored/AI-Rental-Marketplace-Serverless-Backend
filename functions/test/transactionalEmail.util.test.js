const assert = require("node:assert/strict");
const test = require("node:test");
const {
  sendBookingCancelledEmails,
  sendBookingConfirmedEmails,
  sendBookingRequestEmails,
  sendPaymentFailedEmail,
  sendPaymentReceiptEmail,
  sendPayoutEmail,
  sendRefundEmail,
  sendVerificationReviewEmail,
} = require("../utils/transactionalEmail.util");

const booking = {
  id: "booking-1",
  status: "Confirmed",
  renter: { firstName: "Rina", uid: "renter-1" },
  asset: {
    title: "Camera",
    owner: { firstName: "Owner", uid: "owner-1" },
  },
};

test("disabled transactional email skips every email workflow", async () => {
  const pairedResults = await Promise.all([
    sendBookingRequestEmails({ booking, ownerId: "owner-1", renterId: "renter-1", transactionalEmailEnabled: false }),
    sendBookingConfirmedEmails({ booking, ownerId: "owner-1", renterId: "renter-1", transactionalEmailEnabled: false }),
    sendBookingCancelledEmails({ booking, ownerId: "owner-1", renterId: "renter-1", transactionalEmailEnabled: false }),
  ]);
  for (const results of pairedResults) {
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.status, "fulfilled");
      assert.equal(result.value.reason, "email_disabled");
    }
  }

  const singleResults = await Promise.all([
    sendPaymentReceiptEmail({ booking, renterId: "renter-1", transactionalEmailEnabled: false }),
    sendPaymentFailedEmail({ booking, renterId: "renter-1", transactionalEmailEnabled: false }),
    sendRefundEmail({ booking, renterId: "renter-1", refundStatus: "pending", transactionalEmailEnabled: false }),
    sendPayoutEmail({ booking, ownerId: "owner-1", payoutStatus: "pending", transactionalEmailEnabled: false }),
    sendVerificationReviewEmail({ approved: true, submissionId: "submission-1", uid: "renter-1", transactionalEmailEnabled: false }),
  ]);
  for (const result of singleResults) {
    assert.equal(result.reason, "email_disabled");
  }
});
