const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _test: {
    BUSINESS_REGISTRATION_STATUS,
    assertReviewableBusinessRegistrationSubmission,
    assertLinkedVerificationApproved,
    buildBusinessRegistrationApprovedNotification,
    buildBusinessRegistrationRejectedNotification,
    buildBusinessRegistrationSummaryUpdate,
    buildSubmissionReviewUpdate,
    normalizeReviewBusinessRegistrationInput,
  },
} = require("../calls/business/reviewBusinessRegistrationSubmission");

test("normalizeReviewBusinessRegistrationInput requires approval business fields", () => {
  const input = normalizeReviewBusinessRegistrationInput({
    ownerId: "owner-1",
    action: "Approved",
    businessName: "Acme Rentals",
    businessType: "Sole Proprietorship",
    businessAddress: "Makati City",
  });

  assert.equal(input.ownerId, "owner-1");
  assert.equal(input.action, "Approved");
  assert.equal(input.businessName, "Acme Rentals");
});

test("normalizeReviewBusinessRegistrationInput requires rejection reason fields", () => {
  const input = normalizeReviewBusinessRegistrationInput({
    ownerId: "owner-1",
    action: "Rejected",
    rejectionReasonCode: "document_unreadable",
    rejectionReason: "One or more documents are unclear or unreadable.",
  });

  assert.equal(input.ownerId, "owner-1");
  assert.equal(input.action, "Rejected");
  assert.equal(input.rejectionReasonCode, "document_unreadable");
  assert.equal(input.rejectionReason, "One or more documents are unclear or unreadable.");
  assert.equal(input.businessName, null);

  assert.throws(
    () =>
      normalizeReviewBusinessRegistrationInput({
        ownerId: "owner-1",
        action: "Rejected",
        rejectionReasonCode: "unsupported",
        rejectionReason: "Invalid.",
      }),
    /rejection reason is invalid/,
  );
  assert.throws(
    () =>
      normalizeReviewBusinessRegistrationInput({
        ownerId: "owner-1",
        action: "Rejected",
        rejectionReasonCode: "document_unreadable",
        rejectionReason: "",
      }),
    /rejectionReason is invalid/,
  );
});

test("assertReviewableBusinessRegistrationSubmission rejects non-pending submissions", () => {
  assert.throws(
    () =>
      assertReviewableBusinessRegistrationSubmission({
        ownerId: "owner-1",
        status: BUSINESS_REGISTRATION_STATUS.approved,
      }),
    /already reviewed/,
  );
});

test("assertLinkedVerificationApproved requires approved linked verification", async () => {
  await assertLinkedVerificationApproved({
    db: fakeFirestore({
      "verificationSubmissions/submission-approved": {
        userId: "owner-1",
        status: "Approved",
      },
    }),
    ownerId: "owner-1",
    submission: { verificationSubmissionId: "submission-approved" },
    transaction: fakeTransaction({
      "verificationSubmissions/submission-approved": {
        userId: "owner-1",
        status: "Approved",
      },
    }),
  });

  await assert.rejects(
    () =>
      assertLinkedVerificationApproved({
        db: fakeFirestore({
          "verificationSubmissions/submission-pending": {
            userId: "owner-1",
            status: "Pending",
          },
        }),
        ownerId: "owner-1",
        submission: { verificationSubmissionId: "submission-pending" },
        transaction: fakeTransaction({
          "verificationSubmissions/submission-pending": {
            userId: "owner-1",
            status: "Pending",
          },
        }),
      }),
    /linked user verification/,
  );

  await assertLinkedVerificationApproved({
    db: fakeFirestore({}),
    ownerId: "owner-1",
    submission: {},
    transaction: fakeTransaction({}),
  });
});

test("buildSubmissionReviewUpdate stores approved profile data", () => {
  const now = new Date("2026-06-09T00:00:00.000Z");
  const adminUser = { uid: "admin-1", name: "Admin User" };

  assert.deepEqual(
    buildSubmissionReviewUpdate({
      action: BUSINESS_REGISTRATION_STATUS.approved,
      adminUser,
      input: {
        businessAddress: "Makati City",
        businessName: "Acme Rentals",
        businessType: "Corporation",
      },
      now,
    }),
    {
      status: BUSINESS_REGISTRATION_STATUS.approved,
      reviewedAt: now,
      reviewedBy: adminUser,
      rejectionReason: null,
      rejectionReasonCode: null,
      businessName: "Acme Rentals",
      businessType: "Corporation",
      businessAddress: "Makati City",
      updatedAt: now,
    },
  );
});

function fakeFirestore(docs) {
  return {
    collection(collectionName) {
      return {
        doc(docId) {
          return { path: `${collectionName}/${docId}` };
        },
      };
    },
  };
}

function fakeTransaction(docs) {
  return {
    async get(ref) {
      const data = docs[ref.path];
      return {
        exists: data != null,
        data: () => data,
      };
    },
  };
}

test("buildSubmissionReviewUpdate stores rejected reason", () => {
  const now = new Date("2026-06-09T00:00:00.000Z");
  const adminUser = { uid: "admin-1", name: "Admin User" };

  assert.deepEqual(
    buildSubmissionReviewUpdate({
      action: BUSINESS_REGISTRATION_STATUS.rejected,
      adminUser,
      input: {
        rejectionReason: "One or more documents are unclear or unreadable.",
        rejectionReasonCode: "document_unreadable",
      },
      now,
    }),
    {
      status: BUSINESS_REGISTRATION_STATUS.rejected,
      reviewedAt: now,
      reviewedBy: adminUser,
      rejectionReason: "One or more documents are unclear or unreadable.",
      rejectionReasonCode: "document_unreadable",
      businessName: null,
      businessType: null,
      businessAddress: null,
      updatedAt: now,
    },
  );
});

test("buildBusinessRegistrationSummaryUpdate sets approved summary fields", () => {
  const now = new Date("2026-06-09T00:00:00.000Z");
  const adminUser = { uid: "admin-1", name: "Admin User" };

  assert.deepEqual(
    buildBusinessRegistrationSummaryUpdate({
      action: BUSINESS_REGISTRATION_STATUS.approved,
      adminUser,
      existingSummary: {
        required: true,
        visibilityReasons: ["admin_request"],
      },
      input: {
        businessAddress: "Makati City",
        businessName: "Acme Rentals",
        businessType: "Corporation",
      },
      now,
    }),
    {
      required: true,
      visibilityReasons: ["admin_request"],
      visible: true,
      status: BUSINESS_REGISTRATION_STATUS.approved,
      businessName: "Acme Rentals",
      businessType: "Corporation",
      businessAddress: "Makati City",
      reviewedAt: now,
      reviewedBy: adminUser,
      updatedAt: now,
    },
  );
});

test("buildBusinessRegistrationApprovedNotification opens business registration page", () => {
  const notification = buildBusinessRegistrationApprovedNotification({
    businessName: "Acme Rentals",
    ownerId: "owner-1",
  });

  assert.equal(notification.uid, "owner-1");
  assert.equal(notification.title, "Business registration approved");
  assert.equal(notification.body, "Acme Rentals is now approved on Lend.");
  assert.deepEqual(notification.data, {
    type: "business_registration",
    target: "businessRegistration",
    status: BUSINESS_REGISTRATION_STATUS.approved,
  });
});

test("buildBusinessRegistrationRejectedNotification opens business registration rejection page", () => {
  const notification = buildBusinessRegistrationRejectedNotification({
    ownerId: "owner-1",
  });

  assert.equal(notification.uid, "owner-1");
  assert.equal(notification.title, "Business registration rejected");
  assert.equal(
    notification.body,
    "Your business registration was rejected. Open Lend to review your status.",
  );
  assert.deepEqual(notification.data, {
    type: "business_registration",
    target: "businessRegistrationRejection",
    status: BUSINESS_REGISTRATION_STATUS.rejected,
  });
});
