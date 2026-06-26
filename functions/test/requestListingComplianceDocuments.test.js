const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _test: {
    BUSINESS_REGISTRATION_STATUS,
    BUSINESS_REGISTRATION_VISIBILITY_REASON,
    assertOwnerNeedsComplianceDocuments,
    buildBusinessRegistrationRequestNotification,
    buildListingReviewBusinessRegistrationRequestUpdate,
    buildUserBusinessRegistrationRequestUpdate,
    hasOwnerComplianceReview,
    normalizeRequestListingComplianceDocumentsInput,
    uniqueStrings,
  },
} = require("../calls/requestListingComplianceDocuments");

test("normalizeRequestListingComplianceDocumentsInput trims submission id", () => {
  assert.deepEqual(
    normalizeRequestListingComplianceDocumentsInput({
      submissionId: " submission-1 ",
    }),
    { submissionId: "submission-1" },
  );
});

test("hasOwnerComplianceReview accepts risk or AI compliance category", () => {
  assert.equal(
    hasOwnerComplianceReview({
      ownerComplianceRisk: { triggered: true },
    }),
    true,
  );
  assert.equal(
    hasOwnerComplianceReview({
      aiReview: { categories: ["owner_compliance_document_review"] },
    }),
    true,
  );
  assert.equal(
    hasOwnerComplianceReview({
      ownerComplianceRisk: { triggered: false },
      aiReview: { categories: ["restricted_item"] },
    }),
    false,
  );
});

test("assertOwnerNeedsComplianceDocuments rejects approved business registration", () => {
  assert.throws(
    () =>
      assertOwnerNeedsComplianceDocuments({
        businessRegistration: { status: BUSINESS_REGISTRATION_STATUS.approved },
      }),
    /approved business registration/,
  );
  assert.doesNotThrow(() =>
    assertOwnerNeedsComplianceDocuments({
      businessRegistration: { status: BUSINESS_REGISTRATION_STATUS.submitted },
    }),
  );
});

test("buildListingReviewBusinessRegistrationRequestUpdate stores admin request metadata", () => {
  const now = new Date("2026-06-09T00:00:00.000Z");
  const adminUser = { uid: "admin-1", name: "Admin User" };

  assert.deepEqual(
    buildListingReviewBusinessRegistrationRequestUpdate({
      adminUser,
      now,
      ownerId: "owner-1",
    }),
    {
      businessRegistrationRequest: {
        status: BUSINESS_REGISTRATION_STATUS.required,
        requestedAt: now,
        requestedBy: adminUser,
        ownerId: "owner-1",
      },
      updatedAt: now,
    },
  );
});

test("buildUserBusinessRegistrationRequestUpdate reveals Owner Center registration", () => {
  const now = new Date("2026-06-09T00:00:00.000Z");
  const update = buildUserBusinessRegistrationRequestUpdate({
    existingReasons: ["owner_self_declared"],
    now,
    submissionId: "submission-1",
  });

  assert.deepEqual(update, {
    businessRegistration: {
      visible: true,
      required: true,
      status: BUSINESS_REGISTRATION_STATUS.required,
      visibilityReasons: [
        BUSINESS_REGISTRATION_VISIBILITY_REASON.ownerSelfDeclared,
        BUSINESS_REGISTRATION_VISIBILITY_REASON.adminRequest,
      ],
      requestedListingReviewSubmissionId: "submission-1",
      requestedAt: now,
      updatedAt: now,
    },
  });
});

test("buildUserBusinessRegistrationRequestUpdate preserves submitted status", () => {
  const update = buildUserBusinessRegistrationRequestUpdate({
    existingStatus: BUSINESS_REGISTRATION_STATUS.submitted,
    now: new Date("2026-06-09T00:00:00.000Z"),
    submissionId: "submission-1",
  });

  assert.equal(update.businessRegistration.status, BUSINESS_REGISTRATION_STATUS.submitted);
});

test("buildUserBusinessRegistrationRequestUpdate preserves approved status", () => {
  const update = buildUserBusinessRegistrationRequestUpdate({
    existingStatus: BUSINESS_REGISTRATION_STATUS.approved,
    now: new Date("2026-06-09T00:00:00.000Z"),
    submissionId: "submission-1",
  });

  assert.equal(update.businessRegistration.status, BUSINESS_REGISTRATION_STATUS.approved);
});

test("buildBusinessRegistrationRequestNotification opens business registration page", () => {
  const notification = buildBusinessRegistrationRequestNotification({
    imageUrl: "https://example.com/listing.jpg",
    ownerId: "owner-1",
    submissionId: "submission-1",
  });

  assert.equal(notification.uid, "owner-1");
  assert.equal(notification.title, "Business registration required");
  assert.equal(
    notification.body,
    "Your listing is still under review. Submit the required documents in Owner Center > Business Registration.",
  );
  assert.equal(notification.imageUrl, "https://example.com/listing.jpg");
  assert.deepEqual(notification.data, {
    type: "business_registration",
    target: "businessRegistration",
    submissionId: "submission-1",
  });
});

test("uniqueStrings removes blank and duplicate values", () => {
  assert.deepEqual(uniqueStrings(["admin_request", "", "admin_request", "owner_self_declared"]), [
    "admin_request",
    "owner_self_declared",
  ]);
});
