const { formatBookingStartDate } = require("./booking.util");
const { renderTransactionalEmail } = require("./emailTemplateRenderer.util");

const OWNER_NAME_VISIBLE_STATUSES = new Set(["confirmed", "handedover", "returned", "completed"]);

function buildEmailVerificationEmail({ link, recipientName }) {
  return email({
    subject: "Verify your email for Lend",
    recipientName,
    preheader: "Verify your email address to finish securing your Lend account.",
    intro: "Confirm this email address to finish setting up your account and receive important booking updates.",
    action: { label: "Verify email", url: link },
    notice: "This link expires in 24 hours. If you did not request this email, you can safely ignore it.",
  });
}

function buildBookingRequestSubmittedEmail({ booking, recipientName }) {
  const context = bookingEmailContext(booking, { recipientRole: "renter" });
  return bookingEmail({
    subject: "Booking request submitted",
    recipientName,
    intro: "Your request has been sent. We will email you when the owner responds.",
    context,
    actionLabel: "View booking",
  });
}

function buildNewBookingRequestEmail({ booking, recipientName }) {
  const context = bookingEmailContext(booking, { recipientRole: "owner" });
  return bookingEmail({
    subject: "New booking request",
    recipientName,
    intro: "You received a new request. Review the dates and renter details before responding.",
    context,
    actionLabel: "Review request",
  });
}

function buildBookingConfirmedEmail({ booking, recipientName, recipientRole }) {
  const context = bookingEmailContext(booking, { recipientRole });
  return bookingEmail({
    subject: "Booking confirmed",
    recipientName,
    intro: recipientRole === "owner"
      ? "The booking is confirmed. Open Lend to review the handoff details."
      : "Your booking is confirmed. The owner details and handoff information are now available in Lend.",
    context,
    actionLabel: "View booking",
  });
}

function buildBookingCancelledEmail({ booking, recipientName, recipientRole, refundStatus, status = "cancelled" }) {
  const declined = normalizeStatus(status) === "declined";
  const context = bookingEmailContext({ ...booking, status }, { recipientRole, includeAmount: false });
  if (refundStatus) context.details.push({ label: "Refund", value: formatLabel(refundStatus) });
  return bookingEmail({
    subject: declined ? "Booking declined" : "Booking cancelled",
    recipientName,
    intro: declined
      ? "This booking request was not accepted. The dates are available to book elsewhere."
      : "This booking has been cancelled. Review the booking for the latest payment or refund information.",
    context,
    actionLabel: "View booking",
  });
}

function buildPaymentReceiptEmail({ booking, recipientName }) {
  return bookingEmail({
    subject: "Payment received",
    recipientName,
    intro: "Your payment was received and the booking is confirmed.",
    context: bookingEmailContext(booking, { recipientRole: "renter" }),
    actionLabel: "View booking",
  });
}

function buildPaymentFailedEmail({ booking, recipientName }) {
  return bookingEmail({
    subject: "Payment was not completed",
    recipientName,
    intro: "We could not complete your payment. Open Lend to check the booking and try again.",
    context: bookingEmailContext(booking, { recipientRole: "renter" }),
    actionLabel: "Review payment",
  });
}

function buildRefundEmail({ booking, recipientName, refundStatus }) {
  const context = bookingEmailContext(booking, { recipientRole: "renter", includeAmount: false });
  context.details.push({ label: "Refund", value: formatLabel(refundStatus) });
  return bookingEmail({
    subject: "Refund update",
    recipientName,
    intro: "The refund status for your booking has changed.",
    context,
    actionLabel: "View refund",
  });
}

function buildPayoutEmail({ booking, payoutStatus, recipientName }) {
  const context = bookingEmailContext(booking, { recipientRole: "owner", amountType: "payout" });
  context.details.push({ label: "Payout", value: formatLabel(payoutStatus) });
  return bookingEmail({
    subject: "Payout update",
    recipientName,
    intro: "The payout status for this booking has changed.",
    context,
    actionLabel: "View payout",
  });
}

function buildVerificationReviewEmail({ approved, recipientName, submissionId }) {
  const url = approved
    ? "lend://verification"
    : `lend://verification/rejection?submissionId=${encodeURIComponent(submissionId || "")}`;
  return email({
    subject: approved ? "Verification approved" : "Verification rejected",
    recipientName,
    preheader: approved ? "Your Lend verification has been approved." : "Your Lend verification needs attention.",
    intro: approved
      ? "Your full verification has been approved. You can now use the verified features available to your account."
      : "Your verification was not approved. Open Lend to review the reason and next steps.",
    action: { label: approved ? "Open Lend" : "Review verification", url },
  });
}

function bookingEmail({ actionLabel, context, intro, recipientName, subject }) {
  return email({
    subject,
    recipientName,
    preheader: `${subject}: ${context.listingTitle}`,
    intro,
    details: context.details,
    action: context.bookingId ? { label: actionLabel, url: `lend://booking/${encodeURIComponent(context.bookingId)}` } : null,
  });
}

function email({ subject, recipientName, ...content }) {
  return { subject, ...renderTransactionalEmail({ title: subject, greetingName: firstName(recipientName), ...content }) };
}

function bookingEmailContext(booking, { amountType = "total", includeAmount = true, recipientRole } = {}) {
  const listingTitle = clean(booking?.asset?.title || booking?.assetTitle) || "Booking";
  const details = [{ label: "Listing", value: listingTitle }];
  const dateRange = formatDateRange(booking?.startDate || booking?.bookingStartDate, booking?.endDate);
  if (dateRange) details.push({ label: "Dates", value: dateRange });

  const counterpartyName = visibleCounterpartyName(booking, recipientRole);
  if (counterpartyName) details.push({ label: recipientRole === "owner" ? "Renter" : "Owner", value: counterpartyName });

  if (includeAmount) {
    const amount = amountType === "payout" ? payoutAmount(booking) : bookingAmount(booking);
    const formattedAmount = formatMoney(amount, bookingCurrency(booking));
    if (formattedAmount) details.push({ label: amountType === "payout" ? "Amount" : "Total", value: formattedAmount });
  }

  return { bookingId: clean(booking?.id), details, listingTitle };
}

function canRevealOwnerName(status) {
  return OWNER_NAME_VISIBLE_STATUSES.has(normalizeStatus(status));
}

function visibleCounterpartyName(booking, recipientRole) {
  if (recipientRole === "owner") return userName(booking?.renter);
  if (recipientRole === "renter" && canRevealOwnerName(booking?.status)) return userName(booking?.asset?.owner);
  return null;
}

function userName(user) {
  return clean(user?.displayName) || clean([user?.firstName, user?.lastName].filter(Boolean).join(" "));
}

function firstName(value) {
  return clean(value)?.split(/\s+/)[0] || null;
}

function formatDateRange(start, end) {
  const startText = formatBookingStartDate(start);
  const endText = formatBookingStartDate(end);
  if (startText && endText && startText !== endText) return `${startText} - ${endText}`;
  return startText || endText;
}

function bookingAmount(booking) {
  return booking?.totalPrice ?? booking?.paymentFlow?.amount ?? booking?.payment?.amount;
}

function payoutAmount(booking) {
  return booking?.payoutFlow?.amount ?? booking?.settlement?.ownerPayoutAmount ?? booking?.payment?.ownerPayoutAmount;
}

function bookingCurrency(booking) {
  return clean(booking?.priceBreakdown?.currency || booking?.paymentFlow?.currency || booking?.payment?.currency) || "PHP";
}

function formatMoney(value, currency = "PHP") {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  try {
    return new Intl.NumberFormat("en-PH", { style: "currency", currency: String(currency).toUpperCase() }).format(amount);
  } catch (_) {
    return `${String(currency).toUpperCase()} ${amount.toFixed(2)}`;
  }
}

function formatLabel(value) {
  const text = clean(value);
  if (!text) return "Pending";
  return text.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeStatus(value) {
  return String(value || "").toLowerCase().replace(/[\s_-]+/g, "");
}

function clean(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

module.exports = {
  bookingEmailContext,
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
  _test: { formatDateRange, formatMoney, visibleCounterpartyName },
};
