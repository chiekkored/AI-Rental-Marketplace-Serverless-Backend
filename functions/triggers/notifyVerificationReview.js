const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { sendNotificationToUser } = require("../utils/notification.util");
const { sendVerificationReviewEmail } = require("../utils/transactionalEmail.util");
const { FUNCTIONS_REGION } = require("../utils/functionsRegion.util");

const APPROVED = "Approved";
const PENDING = "Pending";
const REJECTED = "Rejected";

function buildVerificationReviewNotification(before, after, submissionId) {
  if (!after?.userId) return null;
  if (before?.status !== PENDING) return null;
  if (![APPROVED, REJECTED].includes(after.status)) return null;

  const approved = after.status === APPROVED;

  return {
    uid: after.userId,
    title: approved ? "Verification approved" : "Verification rejected",
    body: approved
      ? "Your full verification has been approved. You can now list items on Lend."
      : "Your verification was rejected. Open Lend to review your status.",
    data: {
      type: "verification",
      ...(approved ? {} : { target: "verificationRejection" }),
      submissionId,
      status: after.status,
    },
  };
}

exports.notifyVerificationReview = onDocumentUpdated(
  {
    document: "verificationSubmissions/{submissionId}",
    region: FUNCTIONS_REGION,
  },
  async (event) => {
    const notification = buildVerificationReviewNotification(
      event.data?.before?.data(),
      event.data?.after?.data(),
      event.params.submissionId,
    );

    if (!notification) return null;

    await sendNotificationToUser(notification);
    await sendVerificationReviewEmail({
      approved: notification.data.status === APPROVED,
      submissionId: event.params.submissionId,
      uid: notification.uid,
    });
    return null;
  },
);

exports._test = {
  buildVerificationReviewNotification,
};
