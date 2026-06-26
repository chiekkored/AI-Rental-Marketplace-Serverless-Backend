const { resolveTransactionalEmailEnabled, sendTransactionalEmailToUser } = require("./email.util");
const {
  buildBookingCancelledEmail,
  buildBookingConfirmedEmail,
  buildBookingRequestSubmittedEmail,
  buildNewBookingRequestEmail,
  buildPaymentFailedEmail,
  buildPaymentReceiptEmail,
  buildPayoutEmail,
  buildRefundEmail,
  buildVerificationReviewEmail,
} = require("./transactionalEmailTemplates.util");

async function sendBookingRequestEmails({ booking, ownerId, renterId, transactionalEmailEnabled }) {
  const renterName = participantName(booking?.renter);
  const ownerName = participantName(booking?.asset?.owner);
  return runEmailWorkflow(transactionalEmailEnabled, (emailEnabled) => Promise.allSettled([
    sendUserEmail({
      uid: renterId,
      email: buildBookingRequestSubmittedEmail({ booking, recipientName: renterName }),
      idempotencyKey: `booking-request-submitted:${booking.id}:${renterId}`,
      emailCategory: "bookings",
      tag: "booking_request_submitted",
      transactionalEmailEnabled: emailEnabled,
    }),
    sendUserEmail({
      uid: ownerId,
      email: buildNewBookingRequestEmail({ booking, recipientName: ownerName }),
      idempotencyKey: `booking-request-received:${booking.id}:${ownerId}`,
      emailCategory: "bookings",
      tag: "booking_request_received",
      transactionalEmailEnabled: emailEnabled,
    }),
  ]));
}

async function sendBookingConfirmedEmails({ booking, ownerId, renterId, transactionalEmailEnabled }) {
  return runEmailWorkflow(transactionalEmailEnabled, (emailEnabled) => Promise.allSettled([
    sendUserEmail({
    uid: renterId,
    email: buildBookingConfirmedEmail({ booking, recipientName: participantName(booking?.renter), recipientRole: "renter" }),
    idempotencyKey: `booking-confirmed:${booking.id}:${renterId}`,
    emailCategory: "bookings",
    tag: "booking_confirmed",
    transactionalEmailEnabled: emailEnabled,
  }),
    sendUserEmail({
    uid: ownerId,
    email: buildBookingConfirmedEmail({ booking, recipientName: participantName(booking?.asset?.owner), recipientRole: "owner" }),
    idempotencyKey: `booking-confirmed:${booking.id}:${ownerId}`,
    emailCategory: "bookings",
    tag: "booking_confirmed",
    transactionalEmailEnabled: emailEnabled,
  }),
  ]));
}

async function sendBookingCancelledEmails({ booking, ownerId, renterId, refundStatus, status = "cancelled", transactionalEmailEnabled }) {
  return runEmailWorkflow(transactionalEmailEnabled, (emailEnabled) => Promise.allSettled([
    sendUserEmail({
      uid: renterId,
      email: buildBookingCancelledEmail({ booking, recipientName: participantName(booking?.renter), recipientRole: "renter", refundStatus, status }),
      idempotencyKey: `booking-${status}:${booking.id}:${renterId}:${refundStatus || "none"}`,
      emailCategory: "bookings",
      tag: `booking_${status}`,
      transactionalEmailEnabled: emailEnabled,
    }),
    sendUserEmail({
      uid: ownerId,
      email: buildBookingCancelledEmail({ booking, recipientName: participantName(booking?.asset?.owner), recipientRole: "owner", refundStatus, status }),
      idempotencyKey: `booking-${status}:${booking.id}:${ownerId}:${refundStatus || "none"}`,
      emailCategory: "bookings",
      tag: `booking_${status}`,
      transactionalEmailEnabled: emailEnabled,
    }),
  ]));
}

async function sendPaymentReceiptEmail({ booking, renterId, transactionalEmailEnabled }) {
  return runEmailWorkflow(transactionalEmailEnabled, (emailEnabled) => sendUserEmail({
    uid: renterId,
    email: buildPaymentReceiptEmail({ booking, recipientName: participantName(booking?.renter) }),
    idempotencyKey: `payment-receipt:${booking.id}:${renterId}`,
    emailCategory: "payments",
    tag: "payment_receipt",
    transactionalEmailEnabled: emailEnabled,
  }));
}

async function sendPaymentFailedEmail({ booking, renterId, checkoutId, transactionalEmailEnabled }) {
  return runEmailWorkflow(transactionalEmailEnabled, (emailEnabled) => sendUserEmail({
    uid: renterId,
    email: buildPaymentFailedEmail({ booking, recipientName: participantName(booking?.renter) }),
    idempotencyKey: `payment-failed:${booking.id || checkoutId}:${renterId}`,
    emailCategory: "payments",
    tag: "payment_failed",
    transactionalEmailEnabled: emailEnabled,
  }));
}

async function sendRefundEmail({ booking, renterId, refundStatus, transactionalEmailEnabled }) {
  return runEmailWorkflow(transactionalEmailEnabled, (emailEnabled) => sendUserEmail({
    uid: renterId,
    email: buildRefundEmail({ booking, recipientName: participantName(booking?.renter), refundStatus }),
    idempotencyKey: `refund:${booking.id}:${renterId}:${refundStatus}`,
    emailCategory: "payments",
    tag: "refund_update",
    transactionalEmailEnabled: emailEnabled,
  }));
}

async function sendPayoutEmail({ booking, ownerId, payoutStatus, transactionalEmailEnabled }) {
  return runEmailWorkflow(transactionalEmailEnabled, (emailEnabled) => sendUserEmail({
    uid: ownerId,
    email: buildPayoutEmail({ booking, payoutStatus, recipientName: participantName(booking?.asset?.owner) }),
    idempotencyKey: `payout:${booking.id}:${ownerId}:${payoutStatus}`,
    emailCategory: "payments",
    tag: "payout_update",
    transactionalEmailEnabled: emailEnabled,
  }));
}

async function sendVerificationReviewEmail({ approved, submissionId, uid, transactionalEmailEnabled }) {
  return runEmailWorkflow(transactionalEmailEnabled, (emailEnabled) => sendUserEmail({
    uid,
    email: buildVerificationReviewEmail({ approved, submissionId }),
    idempotencyKey: `verification-review:${submissionId}:${uid}`,
    tag: "verification_review",
    transactionalEmailEnabled: emailEnabled,
  }));
}

async function sendUserEmail({ email, emailCategory, idempotencyKey, tag, transactionalEmailEnabled, uid }) {
  if (!uid || !email) return null;
  return sendTransactionalEmailToUser({
    uid,
    idempotencyKey,
    subject: email.subject,
    tag,
    html: email.html,
    text: email.text,
  }, { emailCategory, transactionalEmailEnabled }).catch((error) => {
    console.warn(`[transactional-email] Failed to send ${tag}: ${error.message}`);
    return null;
  });
}

async function runEmailWorkflow(override, operation) {
  const emailEnabled = await resolveTransactionalEmailEnabled({ override });
  if (!emailEnabled) {
    console.log("[transactional-email] Skipped because transactional email is disabled");
  }
  return operation(emailEnabled);
}

function participantName(participant) {
  if (!participant) return null;
  if (typeof participant.displayName === "string" && participant.displayName.trim()) {
    return participant.displayName.trim();
  }
  const fullName = [participant.firstName, participant.lastName].filter(Boolean).join(" ").trim();
  return fullName || null;
}

module.exports = {
  sendBookingCancelledEmails,
  sendBookingConfirmedEmails,
  sendBookingRequestEmails,
  sendPaymentFailedEmail,
  sendPaymentReceiptEmail,
  sendPayoutEmail,
  sendRefundEmail,
  sendVerificationReviewEmail,
};
