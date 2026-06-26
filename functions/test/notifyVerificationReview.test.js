const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../triggers/notifyVerificationReview");

const buildNotification = _test.buildVerificationReviewNotification;

test("builds approved verification review notification", () => {
  assert.deepEqual(
    buildNotification(
      { status: "Pending", userId: "user-1" },
      { status: "Approved", userId: "user-1" },
      "submission-1",
    ),
    {
      uid: "user-1",
      title: "Verification approved",
      body: "Your full verification has been approved. You can now list items on Lend.",
      data: {
        type: "verification",
        submissionId: "submission-1",
        status: "Approved",
      },
    },
  );
});

test("builds rejected verification review notification", () => {
  assert.deepEqual(
    buildNotification(
      { status: "Pending", userId: "user-1" },
      { status: "Rejected", userId: "user-1" },
      "submission-1",
    ),
    {
      uid: "user-1",
      title: "Verification rejected",
      body: "Your verification was rejected. Open Lend to review your status.",
      data: {
        type: "verification",
        target: "verificationRejection",
        submissionId: "submission-1",
        status: "Rejected",
      },
    },
  );
});

test("skips non-final and non-review verification updates", () => {
  assert.equal(
    buildNotification(
      { status: "Pending", userId: "user-1" },
      { status: "Pending", userId: "user-1" },
      "submission-1",
    ),
    null,
  );
  assert.equal(
    buildNotification(
      { status: "Approved", userId: "user-1" },
      { status: "Rejected", userId: "user-1" },
      "submission-1",
    ),
    null,
  );
  assert.equal(
    buildNotification(
      { status: "Pending", userId: "user-1" },
      { status: "Approved" },
      "submission-1",
    ),
    null,
  );
});
