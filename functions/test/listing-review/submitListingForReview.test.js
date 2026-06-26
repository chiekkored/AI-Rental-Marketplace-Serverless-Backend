const assert = require("node:assert/strict");
const test = require("node:test");

const { LISTING_REVIEW_STATUS } = require("../../listing-review/listingModeration.util");
const { _test } = require("../../listing-review/submitListingForReview");

test("rejectQueuedSubmission marks review rejected and notifies owner", async () => {
  const writes = [];
  const notifications = [];
  const now = "server-timestamp";
  const adminUser = {
    uid: "admin-1",
    name: "Admin",
  };
  const submissionRef = {
    set: async (payload, options) => {
      writes.push({ options, payload });
    },
  };
  const queueItem = {
    ownerId: "owner-1",
    listing: {
      title: "Camera",
      images: ["users/owner-1/listingDrafts/draft-1/images/photo.jpg"],
    },
    aiReview: {
      reasons: ["External payment instructions are not allowed."],
    },
  };

  await _test.rejectQueuedSubmission({
    adminUser,
    notes: "Rejected by support",
    now,
    queueItem,
    sendNotificationToUserImpl: async (notification) => {
      notifications.push(notification);
      return { notificationId: "notification-1" };
    },
    submissionId: "submission-1",
    submissionRef,
  });

  assert.deepEqual(writes, [
    {
      options: { merge: true },
      payload: {
        status: LISTING_REVIEW_STATUS.rejected,
        reviewedAt: now,
        updatedAt: now,
        reviewedBy: adminUser,
        adminNotes: "Rejected by support",
      },
    },
  ]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].uid, "owner-1");
  assert.equal(notifications[0].title, "Listing rejected");
  assert.equal(notifications[0].body, "External payment instructions are not allowed.");
  assert.equal(notifications[0].push, true);
  assert.equal(notifications[0].persist, true);
  assert.deepEqual(notifications[0].data, {
    type: "listing_review",
    target: "listingReviewResult",
    submissionId: "submission-1",
    decision: "reject",
  });
});
