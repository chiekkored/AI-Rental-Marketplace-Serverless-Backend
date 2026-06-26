const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");
const {
  deleteDoc,
  doc,
  getDocs,
  collection,
  getDoc,
  increment,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} = require("firebase/firestore");
const {
  getBytes,
  ref,
  uploadString,
} = require("firebase/storage");

const projectId = `lend-rules-${Date.now()}`;

let testEnv;

test.before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8"),
    },
    storage: {
      rules: fs.readFileSync(path.join(__dirname, "../../storage.rules"), "utf8"),
    },
  });
});

test.after(async () => {
  await testEnv?.cleanup();
});

test.beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedFirestore();
});

test("guests can read public assets but cannot create protected documents", async () => {
  const db = testEnv.unauthenticatedContext().firestore();

  await assertSucceeds(getDoc(doc(db, "assets/asset-1")));
  await assertSucceeds(getDocs(collection(db, "assets")));
  await assertFails(setDoc(doc(db, "assets/asset-guest"), assetData("guest")));
  await assertFails(setDoc(doc(db, "users/guest"), { uid: "guest" }));
});

test("prod startup reads are allowed for public and signed-in user data", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertSucceeds(getDocs(collection(ownerDb, "assets")));
  await assertSucceeds(getDoc(doc(ownerDb, "users/owner")));
  await assertSucceeds(getDocs(collection(ownerDb, "users/owner/assets")));
  await assertSucceeds(getDocs(collection(ownerDb, "users/owner/saved")));
  await assertSucceeds(getDocs(collection(ownerDb, "users/owner/bookings")));
  await assertSucceeds(getDocs(collection(ownerDb, "userChats/owner/chats")));

  await assertFails(getDocs(collection(otherDb, "users/owner/assets")));
  await assertFails(getDocs(collection(otherDb, "users/owner/saved")));
  await assertFails(getDocs(collection(otherDb, "users/owner/bookings")));
  await assertFails(getDocs(collection(otherDb, "userChats/owner/chats")));
});

test("maintenance config is publicly readable and admin-managed", async () => {
  const guestDb = testEnv.unauthenticatedContext().firestore();
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();

  await assertSucceeds(getDoc(doc(guestDb, "appConfig/maintenance")));
  await assertFails(getDoc(doc(guestDb, "appConfig/private")));
  await assertFails(setDoc(doc(ownerDb, "appConfig/maintenance"), {
    enabled: true,
    updatedAt: new Date(),
    updatedBy: "owner",
  }));
  await assertSucceeds(setDoc(doc(adminDb, "appConfig/maintenance"), {
    enabled: true,
    updatedAt: new Date(),
    updatedBy: "admin",
  }));
  await assertFails(setDoc(doc(adminDb, "appConfig/maintenance"), {
    enabled: true,
    reason: "extra",
    updatedAt: new Date(),
    updatedBy: "admin",
  }));
  await assertFails(deleteDoc(doc(adminDb, "appConfig/maintenance")));
});

test("dashboard metrics and activity are admin read-only", async () => {
  const guestDb = testEnv.unauthenticatedContext().firestore();
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const newUserDb = testEnv.authenticatedContext("owner-false-founder").firestore();
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();

  await assertFails(getDoc(doc(guestDb, "adminMetrics/dashboard")));
  await assertFails(getDoc(doc(ownerDb, "adminMetrics/dashboard")));
  await assertSucceeds(getDoc(doc(adminDb, "adminMetrics/dashboard")));
  await assertSucceeds(
    getDocs(collection(adminDb, "adminMetrics/dashboard/revenueMonths")),
  );
  await assertSucceeds(getDocs(collection(adminDb, "adminActivityFeed")));

  await assertFails(
    setDoc(doc(adminDb, "adminMetrics/dashboard"), { totalUsers: 10 }),
  );
  await assertFails(
    setDoc(doc(adminDb, "adminActivityFeed/event-1"), { title: "Test" }),
  );
  await assertFails(getDoc(doc(adminDb, "adminMetricEvents/event-1")));
});

test("content pages are publicly readable and admin-managed", async () => {
  const guestDb = testEnv.unauthenticatedContext().firestore();
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();

  await assertSucceeds(getDoc(doc(guestDb, "contentPages/terms-and-conditions")));
  await assertSucceeds(getDoc(doc(guestDb, "contentPages/privacy-policy")));
  await assertSucceeds(getDoc(doc(guestDb, "contentPages/help-center")));
  await assertFails(getDoc(doc(guestDb, "contentPages/private")));

  await assertFails(setDoc(
    doc(ownerDb, "contentPages/terms-and-conditions"),
    legalContentPageData("terms-and-conditions"),
  ));
  await assertSucceeds(setDoc(
    doc(adminDb, "contentPages/terms-and-conditions"),
    legalContentPageData("terms-and-conditions"),
  ));
  await assertSucceeds(setDoc(
    doc(adminDb, "contentPages/help-center"),
    helpCenterContentPageData(),
  ));
  await assertFails(setDoc(
    doc(adminDb, "contentPages/private"),
    legalContentPageData("private"),
  ));
  await assertFails(setDoc(
    doc(adminDb, "contentPages/privacy-policy"),
    {
      ...legalContentPageData("privacy-policy"),
      unexpected: true,
    },
  ));
  await assertFails(deleteDoc(doc(adminDb, "contentPages/help-center")));
});

test("public contact messages are write-only for guests and readable by admins", async () => {
  const guestDb = testEnv.unauthenticatedContext().firestore();
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();

  await assertSucceeds(setDoc(
    doc(guestDb, "contactMessages/message-1"),
    contactMessageData(),
  ));
  await assertFails(getDoc(doc(guestDb, "contactMessages/message-1")));
  await assertFails(getDocs(collection(guestDb, "contactMessages")));
  await assertFails(getDoc(doc(ownerDb, "contactMessages/message-1")));
  await assertSucceeds(getDoc(doc(adminDb, "contactMessages/message-1")));

  await assertFails(setDoc(
    doc(guestDb, "contactMessages/message-extra"),
    contactMessageData({ extra: "blocked" }),
  ));
  await assertFails(setDoc(
    doc(guestDb, "contactMessages/message-empty"),
    contactMessageData({ message: "" }),
  ));
  await assertFails(setDoc(
    doc(guestDb, "contactMessages/message-email"),
    contactMessageData({ email: "not-an-email" }),
  ));
  await assertFails(setDoc(
    doc(guestDb, "contactMessages/message-status"),
    contactMessageData({ status: "Done" }),
  ));
  await assertFails(setDoc(
    doc(guestDb, "contactMessages/message-long"),
    contactMessageData({ message: "x".repeat(2001) }),
  ));
  await assertFails(updateDoc(doc(adminDb, "contactMessages/message-1"), {
    status: "Done",
  }));
  await assertFails(deleteDoc(doc(adminDb, "contactMessages/message-1")));
});

test("early access signups are callable-written and admin-managed", async () => {
  const guestDb = testEnv.unauthenticatedContext().firestore();
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(
      doc(context.firestore(), "earlyAccessSignups/signup-1"),
      earlyAccessSignupData(),
    );
    await setDoc(
      doc(context.firestore(), "earlyAccessSignupRateLimits/rate-1"),
      earlyAccessRateLimitData(),
    );
  });

  await assertFails(setDoc(
    doc(guestDb, "earlyAccessSignups/signup-guest"),
    earlyAccessSignupData(),
  ));
  await assertFails(getDoc(doc(guestDb, "earlyAccessSignups/signup-1")));
  await assertFails(getDocs(collection(guestDb, "earlyAccessSignups")));
  await assertFails(getDoc(doc(ownerDb, "earlyAccessSignups/signup-1")));
  await assertFails(getDocs(collection(ownerDb, "earlyAccessSignups")));
  await assertSucceeds(getDoc(doc(adminDb, "earlyAccessSignups/signup-1")));
  await assertSucceeds(getDocs(collection(adminDb, "earlyAccessSignups")));

  await assertFails(updateDoc(doc(guestDb, "earlyAccessSignups/signup-1"), {
    email: "updated@example.com",
  }));
  await assertFails(deleteDoc(doc(guestDb, "earlyAccessSignups/signup-1")));
  await assertFails(updateDoc(doc(adminDb, "earlyAccessSignups/signup-1"), {
    email: "updated@example.com",
  }));
  await assertFails(updateDoc(doc(guestDb, "earlyAccessSignups/signup-1"), {
    emailedAt: new Date("2026-06-17T02:00:00.000Z"),
    emailedBy: "guest",
    status: "Emailed",
  }));
  await assertFails(updateDoc(doc(ownerDb, "earlyAccessSignups/signup-1"), {
    emailedAt: new Date("2026-06-17T02:00:00.000Z"),
    emailedBy: "owner",
    status: "Emailed",
  }));
  await assertFails(updateDoc(doc(adminDb, "earlyAccessSignups/signup-1"), {
    emailedAt: new Date("2026-06-17T02:00:00.000Z"),
    emailedBy: "other-admin",
    status: "Emailed",
  }));
  await assertSucceeds(updateDoc(doc(adminDb, "earlyAccessSignups/signup-1"), {
    emailedAt: new Date("2026-06-17T02:00:00.000Z"),
    emailedBy: "admin",
    status: "Emailed",
  }));
  await assertSucceeds(updateDoc(doc(adminDb, "earlyAccessSignups/signup-1"), {
    emailedAt: null,
    emailedBy: null,
    status: "Pending",
  }));
  await assertFails(getDoc(doc(adminDb, "earlyAccessSignupRateLimits/rate-1")));
  await assertFails(getDoc(doc(guestDb, "earlyAccessSignupRateLimits/rate-1")));
  await assertFails(setDoc(
    doc(adminDb, "earlyAccessSignupRateLimits/rate-2"),
    earlyAccessRateLimitData(),
  ));
  await assertFails(setDoc(
    doc(guestDb, "earlyAccessSignupRateLimits/rate-3"),
    earlyAccessRateLimitData(),
  ));
  await assertSucceeds(deleteDoc(doc(adminDb, "earlyAccessSignups/signup-1")));
});

test("owner invites are admin-managed and hidden from public clients", async () => {
  const guestDb = testEnv.unauthenticatedContext().firestore();
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(
      doc(context.firestore(), "ownerInvites/juan-camera-rentals"),
      ownerInviteData(),
    );
  });

  await assertFails(getDoc(doc(guestDb, "ownerInvites/juan-camera-rentals")));
  await assertFails(getDocs(collection(guestDb, "ownerInvites")));
  await assertFails(getDoc(doc(ownerDb, "ownerInvites/juan-camera-rentals")));
  await assertFails(setDoc(
    doc(ownerDb, "ownerInvites/owner-created"),
    ownerInviteData(),
  ));
  await assertFails(updateDoc(doc(ownerDb, "ownerInvites/juan-camera-rentals"), {
    status: "Disabled",
  }));

  await assertSucceeds(getDoc(doc(adminDb, "ownerInvites/juan-camera-rentals")));
  await assertSucceeds(getDocs(collection(adminDb, "ownerInvites")));
  await assertSucceeds(setDoc(
    doc(adminDb, "ownerInvites/new-owner"),
    ownerInviteData({ slug: "new-owner", code: "NEW-123" }),
  ));
  await assertSucceeds(updateDoc(doc(adminDb, "ownerInvites/juan-camera-rentals"), {
    status: "Disabled",
  }));
  await assertSucceeds(deleteDoc(doc(adminDb, "ownerInvites/juan-camera-rentals")));
});

test("users can manage only their own profile and saved docs; asset mirrors are backend-created", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertSucceeds(updateDoc(doc(ownerDb, "users/owner"), { firstName: "Updated" }));
  await assertFails(updateDoc(doc(otherDb, "users/owner"), { firstName: "Blocked" }));
  await assertFails(updateDoc(doc(ownerDb, "users/owner"), { status: "Deactivated" }));
  await assertFails(deleteDoc(doc(ownerDb, "users/owner")));

  await assertSucceeds(setDoc(doc(ownerDb, "users/owner/saved/asset-1"), { id: "asset-1" }));
  await assertFails(setDoc(doc(otherDb, "users/owner/saved/asset-2"), { id: "asset-2" }));

  await assertFails(setDoc(doc(ownerDb, "users/owner/assets/asset-2"), { id: "asset-2" }));
  await assertSucceeds(updateDoc(doc(ownerDb, "users/owner/assets/asset-1"), { status: "Hidden" }));
  await assertFails(updateDoc(doc(ownerDb, "users/owner/assets/asset-1"), { title: "Changed" }));
  await assertFails(setDoc(doc(otherDb, "users/owner/assets/asset-3"), { id: "asset-3" }));
});

test("users cannot self-assign founding owner fields", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const newUserDb = testEnv.authenticatedContext("owner-false-founder").firestore();
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();

  await assertFails(updateDoc(doc(ownerDb, "users/owner"), {
    isFoundingOwner: true,
  }));
  await assertFails(updateDoc(doc(ownerDb, "users/owner"), {
    foundingOwner: foundingOwnerData(),
  }));
  await assertFails(updateDoc(doc(ownerDb, "users/owner"), {
    foundingOwnerInvite: foundingOwnerData(),
  }));
  await assertFails(setDoc(doc(ownerDb, "users/fake-founder"), {
    uid: "fake-founder",
    verified: "None",
    isFoundingOwner: true,
  }));
  await assertSucceeds(setDoc(doc(newUserDb, "users/owner-false-founder"), {
    uid: "owner-false-founder",
    verified: "None",
    foundingOwner: null,
    isFoundingOwner: false,
  }));

  await assertSucceeds(updateDoc(doc(adminDb, "users/owner"), {
    foundingOwner: foundingOwnerData(),
    foundingOwnerInvite: foundingOwnerData(),
    isFoundingOwner: true,
  }));
  await assertFails(updateDoc(doc(ownerDb, "users/owner"), {
    firstName: "Founder",
    foundingOwner: {
      ...foundingOwnerData(),
      inviteId: "other-invite",
    },
  }));
  await assertSucceeds(updateDoc(doc(ownerDb, "users/owner"), {
    firstName: "Founder",
  }));
});

test("users can create one pending verification submission atomically", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await updateDoc(doc(db, "users/owner"), {
      verified: "Basic",
      fullVerification: null,
      userMetadataVersion: 1,
    });
  });

  const batch = writeBatch(ownerDb);
  batch.set(doc(ownerDb, "verificationSubmissions/submission-1"), verificationSubmissionData("submission-1", "owner", {
    requestType: "upgrade_verification",
  }));
  batch.update(doc(ownerDb, "users/owner"), {
    fullVerification: verificationSummaryData("submission-1"),
    userMetadataVersion: increment(1),
  });

  await assertSucceeds(batch.commit());
  await assertFails(setDoc(
    doc(otherDb, "verificationSubmissions/submission-other"),
    verificationSubmissionData("submission-other", "owner"),
  ));
});

test("basic users can submit self-declared business registration with verification", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await updateDoc(doc(db, "users/owner"), {
      verified: "Basic",
      fullVerification: null,
      businessRegistration: null,
      userMetadataVersion: 1,
    });
  });

  const mismatchBatch = writeBatch(ownerDb);
  mismatchBatch.set(
    doc(ownerDb, "verificationSubmissions/submission-business-owner-mismatch"),
    verificationSubmissionData("submission-business-owner-mismatch", "owner", {
      isRentalBusinessOwner: true,
      requestType: "upgrade_verification",
    }),
  );
  mismatchBatch.set(
    doc(ownerDb, "businessRegistrationSubmissions/owner"),
    businessRegistrationSubmissionData("owner", {
      requestedListingReviewSubmissionId: null,
      verificationSubmissionId: "wrong-submission",
    }),
  );
  mismatchBatch.update(doc(ownerDb, "users/owner"), {
    fullVerification: verificationSummaryData("submission-business-owner-mismatch"),
    businessRegistration: {
      visible: true,
      required: false,
      status: "Submitted",
      visibilityReasons: ["owner_self_declared"],
      requestedListingReviewSubmissionId: null,
      submittedAt: new Date("2026-06-09T01:00:00.000Z"),
      updatedAt: new Date("2026-06-09T01:00:00.000Z"),
    },
    userMetadataVersion: increment(1),
  });
  await assertFails(mismatchBatch.commit());

  const batch = writeBatch(ownerDb);
  batch.set(
    doc(ownerDb, "verificationSubmissions/submission-business-owner"),
    verificationSubmissionData("submission-business-owner", "owner", {
      isRentalBusinessOwner: true,
      requestType: "upgrade_verification",
    }),
  );
  batch.set(
    doc(ownerDb, "businessRegistrationSubmissions/owner"),
    businessRegistrationSubmissionData("owner", {
      requestedListingReviewSubmissionId: null,
      verificationSubmissionId: "submission-business-owner",
    }),
  );
  batch.update(doc(ownerDb, "users/owner"), {
    fullVerification: verificationSummaryData("submission-business-owner"),
    businessRegistration: {
      visible: true,
      required: false,
      status: "Submitted",
      visibilityReasons: ["owner_self_declared"],
      requestedListingReviewSubmissionId: null,
      submittedAt: new Date("2026-06-09T01:00:00.000Z"),
      updatedAt: new Date("2026-06-09T01:00:00.000Z"),
    },
    userMetadataVersion: increment(1),
  });

  await assertSucceeds(batch.commit());
});

test("owners can resubmit rejected self-declared business registration with verification", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await updateDoc(doc(db, "users/owner"), {
      verified: "Basic",
      fullVerification: {
        status: "Rejected",
        activeSubmissionId: "old-verification",
        submittedAt: new Date("2026-06-08T01:00:00.000Z"),
        reviewedAt: new Date("2026-06-08T02:00:00.000Z"),
      },
      businessRegistration: {
        visible: true,
        required: false,
        status: "Rejected",
        visibilityReasons: ["owner_self_declared"],
        requestedListingReviewSubmissionId: null,
        submittedAt: new Date("2026-06-08T01:00:00.000Z"),
        reviewedAt: new Date("2026-06-08T02:00:00.000Z"),
        updatedAt: new Date("2026-06-08T02:00:00.000Z"),
      },
      userMetadataVersion: 1,
    });
    await setDoc(
      doc(db, "businessRegistrationSubmissions/owner"),
      businessRegistrationSubmissionData("owner", {
        rejectionReason: "One or more documents are unclear or unreadable.",
        rejectionReasonCode: "document_unreadable",
        requestedListingReviewSubmissionId: null,
        reviewedAt: new Date("2026-06-08T02:00:00.000Z"),
        reviewedBy: { uid: "admin", name: "Admin User" },
        status: "Rejected",
        verificationSubmissionId: "old-verification",
      }),
    );
  });

  const staleBatch = writeBatch(ownerDb);
  staleBatch.set(
    doc(ownerDb, "verificationSubmissions/resubmission-stale-business"),
    verificationSubmissionData("resubmission-stale-business", "owner", {
      isRentalBusinessOwner: true,
      requestType: "upgrade_verification",
    }),
  );
  staleBatch.set(
    doc(ownerDb, "businessRegistrationSubmissions/owner"),
    businessRegistrationSubmissionData("owner", {
      rejectionReason: "One or more documents are unclear or unreadable.",
      rejectionReasonCode: "document_unreadable",
      requestedListingReviewSubmissionId: null,
      verificationSubmissionId: "resubmission-stale-business",
    }),
  );
  staleBatch.update(doc(ownerDb, "users/owner"), {
    fullVerification: verificationSummaryData("resubmission-stale-business"),
    businessRegistration: {
      visible: true,
      required: false,
      status: "Submitted",
      visibilityReasons: ["owner_self_declared"],
      requestedListingReviewSubmissionId: null,
      submittedAt: new Date("2026-06-09T01:00:00.000Z"),
      updatedAt: new Date("2026-06-09T01:00:00.000Z"),
    },
    userMetadataVersion: increment(1),
  });
  await assertFails(staleBatch.commit());

  const cleanBatch = writeBatch(ownerDb);
  cleanBatch.set(
    doc(ownerDb, "verificationSubmissions/resubmission-clean-business"),
    verificationSubmissionData("resubmission-clean-business", "owner", {
      isRentalBusinessOwner: true,
      requestType: "upgrade_verification",
    }),
  );
  cleanBatch.set(
    doc(ownerDb, "businessRegistrationSubmissions/owner"),
    businessRegistrationSubmissionData("owner", {
      requestedListingReviewSubmissionId: null,
      verificationSubmissionId: "resubmission-clean-business",
    }),
  );
  cleanBatch.update(doc(ownerDb, "users/owner"), {
    fullVerification: verificationSummaryData("resubmission-clean-business"),
    businessRegistration: {
      visible: true,
      required: false,
      status: "Submitted",
      visibilityReasons: ["owner_self_declared"],
      requestedListingReviewSubmissionId: null,
      submittedAt: new Date("2026-06-09T01:00:00.000Z"),
      updatedAt: new Date("2026-06-09T01:00:00.000Z"),
    },
    userMetadataVersion: increment(1),
  });
  await assertSucceeds(cleanBatch.commit());
});

test("basic users cannot submit standalone business registration documents", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await updateDoc(doc(db, "users/owner"), {
      verified: "Basic",
      fullVerification: null,
      businessRegistration: null,
      userMetadataVersion: 1,
    });
  });

  const batch = writeBatch(ownerDb);
  batch.set(
    doc(ownerDb, "businessRegistrationSubmissions/owner"),
    businessRegistrationSubmissionData("owner", {
      requestedListingReviewSubmissionId: null,
    }),
  );
  batch.update(doc(ownerDb, "users/owner"), {
    businessRegistration: {
      visible: true,
      required: false,
      status: "Submitted",
      visibilityReasons: ["owner_self_declared"],
      requestedListingReviewSubmissionId: null,
      submittedAt: new Date("2026-06-09T01:00:00.000Z"),
      updatedAt: new Date("2026-06-09T01:00:00.000Z"),
    },
    userMetadataVersion: increment(1),
  });

  await assertFails(batch.commit());
});

test("full verification submission cannot update profile fields before review", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await updateDoc(doc(db, "users/owner"), {
      verified: "Basic",
      fullVerification: null,
      userMetadataVersion: 1,
    });
  });

  const batch = writeBatch(ownerDb);
  batch.set(doc(ownerDb, "verificationSubmissions/submission-profile-write"), verificationSubmissionData("submission-profile-write", "owner", {
    requestType: "upgrade_verification",
  }));
  batch.update(doc(ownerDb, "users/owner"), {
    phone: "09171234567",
    fullVerification: verificationSummaryData("submission-profile-write"),
    userMetadataVersion: increment(1),
  });

  await assertFails(batch.commit());
});

test("account information submissions only update pending verification metadata", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();

  const blockedBatch = writeBatch(ownerDb);
  blockedBatch.set(
    doc(ownerDb, "verificationSubmissions/account-update-blocked"),
    verificationSubmissionData("account-update-blocked", "owner", {
      requestType: "account_information_update",
      updatedFields: ["fullName"],
    }),
  );
  blockedBatch.update(doc(ownerDb, "users/owner"), {
    firstName: "Changed Before Review",
    fullVerification: verificationSummaryData("account-update-blocked"),
    userMetadataVersion: increment(1),
    verified: "Basic",
  });

  await assertFails(blockedBatch.commit());

  const batch = writeBatch(ownerDb);
  batch.set(
    doc(ownerDb, "verificationSubmissions/account-update-1"),
    verificationSubmissionData("account-update-1", "owner", {
      firstName: "Changed After Review",
      requestType: "account_information_update",
      updatedFields: ["fullName"],
    }),
  );
  batch.update(doc(ownerDb, "users/owner"), {
    fullVerification: verificationSummaryData("account-update-1"),
    userMetadataVersion: increment(1),
    verified: "Basic",
  });

  await assertSucceeds(batch.commit());
  await assertFails(updateDoc(doc(ownerDb, "users/owner"), {
    firstName: "Changed While Pending",
  }));
});

test("users cannot create another verification submission while pending", async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await updateDoc(doc(db, "users/owner"), {
      fullVerification: verificationSummaryData("submission-existing"),
    });
  });

  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const batch = writeBatch(ownerDb);
  batch.set(doc(ownerDb, "verificationSubmissions/submission-2"), verificationSubmissionData("submission-2", "owner"));
  batch.update(doc(ownerDb, "users/owner"), {
    phone: "09176543210",
    fullVerification: verificationSummaryData("submission-2"),
    userMetadataVersion: increment(1),
  });

  await assertFails(batch.commit());
});

test("admins can review verification submissions and non-admins cannot", async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "verificationSubmissions/submission-1"), verificationSubmissionData("submission-1", "owner"));
    await setDoc(doc(db, "verificationSubmissions/submission-2"), verificationSubmissionData("submission-2", "owner"));
    await setDoc(doc(db, "verificationSubmissions/submission-3"), verificationSubmissionData("submission-3", "owner"));
  });

  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();
  const ownerDb = testEnv.authenticatedContext("owner").firestore();

  await assertSucceeds(updateDoc(doc(adminDb, "verificationSubmissions/submission-1"), {
    reviewedAt: new Date("2026-04-03T00:00:00.000Z"),
    status: "Approved",
  }));
  await assertSucceeds(updateDoc(doc(adminDb, "verificationSubmissions/submission-2"), {
    rejectionReason: "Submitted information does not match your verification records.",
    rejectionReasonCode: "information_mismatch",
    reviewedAt: new Date("2026-04-03T00:00:00.000Z"),
    status: "Rejected",
  }));
  await assertFails(updateDoc(doc(adminDb, "verificationSubmissions/submission-3"), {
    reviewedAt: new Date("2026-04-03T00:00:00.000Z"),
    status: "Rejected",
  }));
  await assertFails(updateDoc(doc(ownerDb, "verificationSubmissions/submission-1"), {
    status: "Rejected",
  }));
});

test("public asset writes are backend-created and owner status updates are limited", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertFails(setDoc(doc(ownerDb, "assets/asset-owner-new"), assetData("owner")));
  await assertFails(setDoc(doc(ownerDb, "assets/asset-other-new"), assetData("other")));
  await assertSucceeds(updateDoc(doc(ownerDb, "assets/asset-1"), { status: "Hidden" }));
  await assertFails(updateDoc(doc(ownerDb, "assets/asset-1"), { title: "Changed" }));
  await assertFails(updateDoc(doc(otherDb, "assets/asset-1"), { title: "Hijacked" }));

  await assertFails(setDoc(doc(ownerDb, "assets/asset-1/bookings/booking-new"), bookingData()));
  await assertFails(updateDoc(doc(ownerDb, "assets/asset-1/bookings/booking-1"), { status: "Confirmed" }));
  await assertFails(setDoc(doc(ownerDb, "assets/asset-1/ratings/rating-new"), { rating: 5 }));
});

test("owners cannot update listings during deactivation review or after lock", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await updateDoc(doc(db, "assets/asset-1"), {
      deactivationReview: { requestId: "request-1", status: "Pending" },
    });
    await updateDoc(doc(db, "users/owner/assets/asset-1"), {
      deactivationReview: { requestId: "request-1", status: "Pending" },
    });
  });

  await assertFails(updateDoc(doc(ownerDb, "assets/asset-1"), { status: "Hidden" }));
  await assertFails(updateDoc(doc(ownerDb, "users/owner/assets/asset-1"), { status: "Hidden" }));

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await updateDoc(doc(db, "assets/asset-1"), {
      deactivationLock: { locked: true, requestId: "request-1" },
      deactivationReview: { requestId: "request-1", status: "Approved" },
      status: "Archived",
    });
    await updateDoc(doc(db, "users/owner/assets/asset-1"), {
      deactivationLock: { locked: true, requestId: "request-1" },
      deactivationReview: { requestId: "request-1", status: "Approved" },
      status: "Archived",
    });
  });

  await assertFails(updateDoc(doc(ownerDb, "assets/asset-1"), { status: "Available" }));
  await assertFails(updateDoc(doc(ownerDb, "users/owner/assets/asset-1"), { status: "Available" }));
});

test("admins can update canonical assets and owner asset mirrors", async () => {
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertSucceeds(updateDoc(doc(adminDb, "assets/asset-1"), { status: "Rejected" }));
  await assertSucceeds(updateDoc(doc(adminDb, "users/owner/assets/asset-1"), { status: "Rejected" }));
  await assertFails(updateDoc(doc(otherDb, "users/owner/assets/asset-1"), { status: "Rejected" }));
});

test("admins can create asset audits and non-admins cannot", async () => {
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();
  const ownerDb = testEnv.authenticatedContext("owner").firestore();

  await assertSucceeds(setDoc(doc(adminDb, "assets/asset-1/audits/audit-1"), auditData("Rejected")));
  await assertSucceeds(getDoc(doc(adminDb, "assets/asset-1/audits/audit-1")));
  await assertFails(setDoc(doc(ownerDb, "assets/asset-1/audits/audit-2"), auditData("Deleted")));
  await assertFails(updateDoc(doc(adminDb, "assets/asset-1/audits/audit-1"), { notes: "Changed" }));
});

test("account feedback is backend-written and admin-readable", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();
  const guestDb = testEnv.unauthenticatedContext().firestore();
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(
      doc(db, "accountFeedback/feedback-1"),
      accountFeedbackData("feedback-1"),
    );
  });

  await assertSucceeds(getDoc(doc(adminDb, "accountFeedback/feedback-1")));
  await assertFails(getDoc(doc(otherDb, "accountFeedback/feedback-1")));
  await assertFails(updateDoc(doc(ownerDb, "accountFeedback/feedback-1"), { reason: "Changed" }));
  await assertFails(deleteDoc(doc(ownerDb, "accountFeedback/feedback-1")));

  await assertFails(setDoc(
    doc(ownerDb, "accountFeedback/feedback-owner"),
    accountFeedbackData("feedback-owner"),
  ));
  await assertFails(setDoc(
    doc(guestDb, "accountFeedback/feedback-guest"),
    accountFeedbackData("feedback-guest"),
  ));
  await assertFails(setDoc(
    doc(ownerDb, "accountFeedback/feedback-personal"),
    {
      ...accountFeedbackData("feedback-personal"),
      uid: "owner",
      email: "owner@example.com",
    },
  ));
  await assertFails(setDoc(
    doc(ownerDb, "accountFeedback/feedback-disable-text"),
    accountFeedbackData("feedback-disable-text", {
      action: "disable",
      feedback: "This should only be accepted for delete feedback.",
    }),
  ));
});

test("listing review submissions are backend-written and owner/admin-readable", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "listingReviewSubmissions/submission-1"), {
      id: "submission-1",
      ownerId: "owner",
      status: "Pending",
    });
  });

  await assertSucceeds(getDoc(doc(adminDb, "listingReviewSubmissions/submission-1")));
  await assertSucceeds(getDoc(doc(ownerDb, "listingReviewSubmissions/submission-1")));
  await assertFails(getDoc(doc(otherDb, "listingReviewSubmissions/submission-1")));
  await assertFails(setDoc(doc(ownerDb, "listingReviewSubmissions/submission-owner"), {
    id: "submission-owner",
    ownerId: "owner",
    status: "Pending",
  }));
  await assertFails(updateDoc(doc(adminDb, "listingReviewSubmissions/submission-1"), {
    status: "Approved",
  }));
});

test("owners can submit their own business registration documents", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await updateDoc(doc(db, "users/owner"), {
      businessRegistration: {
        visible: true,
        required: true,
        status: "Required",
        visibilityReasons: ["admin_request"],
        requestedListingReviewSubmissionId: "submission-1",
        requestedAt: new Date("2026-06-09T00:00:00.000Z"),
        updatedAt: new Date("2026-06-09T00:00:00.000Z"),
      },
    });
  });

  const batch = writeBatch(ownerDb);
  batch.set(doc(ownerDb, "businessRegistrationSubmissions/owner"), businessRegistrationSubmissionData("owner"));
  batch.update(doc(ownerDb, "users/owner"), {
    businessRegistration: {
      visible: true,
      required: true,
      status: "Submitted",
      visibilityReasons: ["admin_request"],
      requestedListingReviewSubmissionId: "submission-1",
      submittedAt: new Date("2026-06-09T01:00:00.000Z"),
      updatedAt: new Date("2026-06-09T01:00:00.000Z"),
    },
    userMetadataVersion: increment(1),
  });

  await assertSucceeds(batch.commit());
  await assertSucceeds(getDoc(doc(ownerDb, "businessRegistrationSubmissions/owner")));
  await assertSucceeds(getDoc(doc(adminDb, "businessRegistrationSubmissions/owner")));
  await assertFails(getDoc(doc(otherDb, "businessRegistrationSubmissions/owner")));
  await assertSucceeds(setDoc(
    doc(adminDb, "businessRegistrationSubmissions/owner"),
    businessRegistrationSubmissionData("owner", {
      rejectionReason: "One or more documents are unclear or unreadable.",
      rejectionReasonCode: "document_unreadable",
      reviewedAt: new Date("2026-06-09T02:00:00.000Z"),
      reviewedBy: { uid: "admin", name: "Admin User" },
      status: "Rejected",
    }),
  ));
  await assertFails(setDoc(
    doc(ownerDb, "businessRegistrationSubmissions/owner"),
    businessRegistrationSubmissionData("owner", {
      rejectionReasonCode: "document_unreadable",
    }),
  ));
  await assertFails(setDoc(
    doc(otherDb, "businessRegistrationSubmissions/owner"),
    businessRegistrationSubmissionData("owner"),
  ));
});

test("owners can resubmit rejected listing-linked business registration documents", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await updateDoc(doc(db, "users/owner"), {
      verified: "Full",
      businessRegistration: {
        visible: true,
        required: true,
        status: "Rejected",
        visibilityReasons: ["admin_request"],
        requestedListingReviewSubmissionId: "submission-1",
        requestedAt: new Date("2026-06-09T00:00:00.000Z"),
        submittedAt: new Date("2026-06-09T01:00:00.000Z"),
        reviewedAt: new Date("2026-06-09T02:00:00.000Z"),
        updatedAt: new Date("2026-06-09T02:00:00.000Z"),
      },
    });
    await setDoc(
      doc(db, "businessRegistrationSubmissions/owner"),
      businessRegistrationSubmissionData("owner", {
        rejectionReason: "Required business registration documents are incomplete.",
        rejectionReasonCode: "document_incomplete",
        reviewedAt: new Date("2026-06-09T02:00:00.000Z"),
        reviewedBy: { uid: "admin", name: "Admin User" },
        status: "Rejected",
      }),
    );
  });

  const staleBatch = writeBatch(ownerDb);
  staleBatch.set(
    doc(ownerDb, "businessRegistrationSubmissions/owner"),
    businessRegistrationSubmissionData("owner", {
      rejectionReason: "Required business registration documents are incomplete.",
      rejectionReasonCode: "document_incomplete",
    }),
  );
  staleBatch.update(doc(ownerDb, "users/owner"), {
    businessRegistration: {
      visible: true,
      required: true,
      status: "Submitted",
      visibilityReasons: ["admin_request"],
      requestedListingReviewSubmissionId: "submission-1",
      submittedAt: new Date("2026-06-10T01:00:00.000Z"),
      updatedAt: new Date("2026-06-10T01:00:00.000Z"),
    },
    userMetadataVersion: increment(1),
  });
  await assertFails(staleBatch.commit());

  const cleanBatch = writeBatch(ownerDb);
  cleanBatch.set(
    doc(ownerDb, "businessRegistrationSubmissions/owner"),
    businessRegistrationSubmissionData("owner", {
      submittedAt: new Date("2026-06-10T01:00:00.000Z"),
      updatedAt: new Date("2026-06-10T01:00:00.000Z"),
    }),
  );
  cleanBatch.update(doc(ownerDb, "users/owner"), {
    businessRegistration: {
      visible: true,
      required: true,
      status: "Submitted",
      visibilityReasons: ["admin_request"],
      requestedListingReviewSubmissionId: "submission-1",
      submittedAt: new Date("2026-06-10T01:00:00.000Z"),
      updatedAt: new Date("2026-06-10T01:00:00.000Z"),
    },
    userMetadataVersion: increment(1),
  });
  await assertSucceeds(cleanBatch.commit());
});

test("non-full users cannot submit business registration documents", async () => {
  const renterDb = testEnv.authenticatedContext("renter").firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await updateDoc(doc(db, "users/renter"), {
      businessRegistration: {
        visible: true,
        required: true,
        status: "Required",
        visibilityReasons: ["admin_request"],
        requestedListingReviewSubmissionId: "submission-1",
        requestedAt: new Date("2026-06-09T00:00:00.000Z"),
        updatedAt: new Date("2026-06-09T00:00:00.000Z"),
      },
    });
  });

  const batch = writeBatch(renterDb);
  batch.set(doc(renterDb, "businessRegistrationSubmissions/renter"), businessRegistrationSubmissionData("renter"));
  batch.update(doc(renterDb, "users/renter"), {
    businessRegistration: {
      visible: true,
      required: true,
      status: "Submitted",
      visibilityReasons: ["admin_request"],
      requestedListingReviewSubmissionId: "submission-1",
      submittedAt: new Date("2026-06-09T01:00:00.000Z"),
      updatedAt: new Date("2026-06-09T01:00:00.000Z"),
    },
    userMetadataVersion: increment(1),
  });

  await assertFails(batch.commit());
});

test("owners can self-reveal business registration from verification flow", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();

  await assertSucceeds(updateDoc(doc(ownerDb, "users/owner"), {
    businessRegistration: {
      visible: true,
      required: false,
      status: "Not Submitted",
      visibilityReasons: ["owner_self_declared"],
      updatedAt: new Date("2026-06-09T00:00:00.000Z"),
    },
    userMetadataVersion: increment(1),
  }));
  await assertFails(updateDoc(doc(ownerDb, "users/owner"), {
    businessRegistration: {
      visible: true,
      required: true,
      status: "Required",
      visibilityReasons: ["owner_self_declared"],
      updatedAt: new Date("2026-06-09T00:00:00.000Z"),
    },
    userMetadataVersion: increment(1),
  }));
});

test("owners can update their business-name listing preference only on their own user", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertSucceeds(updateDoc(doc(ownerDb, "users/owner"), {
    useBusinessNameForListingOwnerName: true,
  }));

  await assertFails(updateDoc(doc(otherDb, "users/owner"), {
    useBusinessNameForListingOwnerName: true,
  }));
});

test("listing deactivation requests are backend-written and owner/admin-readable", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "listingDeactivationRequests/request-1"), {
      id: "request-1",
      assetId: "asset-1",
      ownerId: "owner",
      status: "Pending",
    });
  });

  await assertSucceeds(getDoc(doc(adminDb, "listingDeactivationRequests/request-1")));
  await assertSucceeds(getDoc(doc(ownerDb, "listingDeactivationRequests/request-1")));
  await assertFails(getDoc(doc(otherDb, "listingDeactivationRequests/request-1")));
  await assertFails(setDoc(doc(ownerDb, "listingDeactivationRequests/request-owner"), {
    id: "request-owner",
    ownerId: "owner",
    status: "Pending",
  }));
  await assertFails(updateDoc(doc(adminDb, "listingDeactivationRequests/request-1"), {
    status: "Approved",
  }));
});

test("amenities are admin-managed and active amenities are client-readable", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();
  const guestDb = testEnv.unauthenticatedContext().firestore();
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "amenities/wifi"), amenityData("wifi", {
      isActive: true,
      sortOrder: 10,
    }));
    await setDoc(doc(db, "amenities/private-pool"), amenityData("private-pool", {
      isActive: false,
      sortOrder: 20,
    }));
  });

  await assertSucceeds(getDoc(doc(ownerDb, "amenities/wifi")));
  await assertSucceeds(getDoc(doc(guestDb, "amenities/wifi")));
  await assertFails(getDoc(doc(otherDb, "amenities/private-pool")));
  await assertSucceeds(getDoc(doc(adminDb, "amenities/private-pool")));
  await assertSucceeds(getDocs(query(
    collection(ownerDb, "amenities"),
    where("isActive", "==", true),
    orderBy("sortOrder"),
  )));

  await assertSucceeds(setDoc(doc(adminDb, "amenities/parking"), amenityData("parking")));
  await assertSucceeds(updateDoc(doc(adminDb, "amenities/wifi"), {
    label: "Wi-Fi",
    updatedAt: new Date("2026-04-03T00:00:00.000Z"),
  }));
  await assertFails(setDoc(doc(ownerDb, "amenities/blocked"), amenityData("blocked")));
  await assertFails(updateDoc(doc(ownerDb, "amenities/wifi"), {
    label: "Blocked",
  }));
  await assertFails(deleteDoc(doc(adminDb, "amenities/wifi")));
});

test("admins can update booking mirrors and user chat booking summaries", async () => {
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertSucceeds(updateDoc(doc(adminDb, "assets/asset-1/bookings/booking-1"), { status: "Cancelled" }));
  await assertSucceeds(updateDoc(doc(adminDb, "users/renter/bookings/booking-1"), { status: "Cancelled" }));
  await assertSucceeds(updateDoc(doc(adminDb, "userChats/owner/chats/chat-1"), { bookingStatus: "Cancelled" }));
  await assertFails(updateDoc(doc(otherDb, "assets/asset-1/bookings/booking-1"), { status: "Cancelled" }));
});

test("booking reads allow signed-in asset booking reads and limit user mirrors", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const renterDb = testEnv.authenticatedContext("renter").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertSucceeds(getDoc(doc(ownerDb, "assets/asset-1/bookings/booking-1")));
  await assertSucceeds(getDoc(doc(renterDb, "assets/asset-1/bookings/booking-1")));
  await assertSucceeds(getDoc(doc(otherDb, "assets/asset-1/bookings/booking-1")));

  await assertSucceeds(getDoc(doc(ownerDb, "users/renter/bookings/booking-1")));
  await assertSucceeds(getDoc(doc(renterDb, "users/renter/bookings/booking-1")));
  await assertFails(getDoc(doc(otherDb, "users/renter/bookings/booking-1")));
});

test("users can list only their own booking mirror collection", async () => {
  const renterDb = testEnv.authenticatedContext("renter").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertSucceeds(getDocs(collection(renterDb, "users/renter/bookings")));
  await assertFails(getDocs(collection(otherDb, "users/renter/bookings")));
});

test("users can read and mark only their own notifications", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "users/owner/notifications/notification-1"), notificationData());
  });

  await assertSucceeds(getDocs(collection(ownerDb, "users/owner/notifications")));
  await assertSucceeds(updateDoc(doc(ownerDb, "users/owner/notifications/notification-1"), {
    readAt: new Date("2026-04-03T00:00:00.000Z"),
  }));
  await assertFails(getDocs(collection(otherDb, "users/owner/notifications")));
  await assertFails(setDoc(doc(ownerDb, "users/owner/notifications/notification-2"), notificationData()));
  await assertFails(updateDoc(doc(ownerDb, "users/owner/notifications/notification-1"), {
    title: "Changed",
  }));
  await assertFails(deleteDoc(doc(ownerDb, "users/owner/notifications/notification-1")));
});

test("users can read only their own listing moderation events", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "users/owner/listingModerationEvents/event-1"), {
      action: "Deleted",
      assetId: "asset-1",
      reason: "Policy violation",
    });
  });

  await assertSucceeds(getDoc(doc(ownerDb, "users/owner/listingModerationEvents/event-1")));
  await assertFails(getDoc(doc(otherDb, "users/owner/listingModerationEvents/event-1")));
  await assertFails(setDoc(doc(ownerDb, "users/owner/listingModerationEvents/event-2"), {
    action: "Deleted",
    assetId: "asset-2",
    reason: "Policy violation",
  }));
  await assertFails(updateDoc(doc(ownerDb, "users/owner/listingModerationEvents/event-1"), {
    reason: "Changed",
  }));
  await assertFails(deleteDoc(doc(ownerDb, "users/owner/listingModerationEvents/event-1")));
});

test("user booking updates cannot mutate lifecycle fields", async () => {
  const renterDb = testEnv.authenticatedContext("renter").firestore();

  await assertFails(updateDoc(doc(renterDb, "users/renter/bookings/booking-1"), { status: "Confirmed" }));
  await assertFails(deleteDoc(doc(renterDb, "users/renter/bookings/booking-1")));
});

test("chat messages are limited to chat participants", async () => {
  const renterDb = testEnv.authenticatedContext("renter").firestore();
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();

  await assertSucceeds(getDoc(doc(ownerDb, "chats/chat-1")));
  await assertSucceeds(getDoc(doc(adminDb, "chats/chat-1")));
  await assertSucceeds(getDocs(collection(adminDb, "chats/chat-1/messages")));
  await assertSucceeds(getDocs(collection(renterDb, "chats/chat-1/messages")));
  await assertSucceeds(getDocs(collection(ownerDb, "chats/chat-1/messages")));
  await assertSucceeds(getDoc(doc(renterDb, "chats/chat-1/messages/message-1")));
  await assertSucceeds(getDoc(doc(ownerDb, "chats/chat-1/messages/message-1")));
  await assertSucceeds(setDoc(doc(renterDb, "chats/chat-1/messages/message-new"), {
    id: "message-new",
    text: "Hello",
    senderId: "renter",
    visibleTo: ["renter", "owner"],
  }));
  await assertFails(getDoc(doc(otherDb, "chats/chat-1")));
  await assertFails(getDoc(doc(otherDb, "chats/chat-1/messages/message-1")));
  await assertFails(getDocs(collection(otherDb, "chats/chat-1/messages")));
  await assertFails(setDoc(doc(otherDb, "chats/chat-1/messages/message-blocked"), {
    id: "message-blocked",
    text: "Blocked",
    senderId: "other",
    visibleTo: ["other"],
  }));
});

test("message visibility limits renter-only rating prompts", async () => {
  const renterDb = testEnv.authenticatedContext("renter").firestore();
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertSucceeds(getDoc(doc(renterDb, "chats/chat-1/messages/rating-request")));
  await assertSucceeds(getDoc(doc(ownerDb, "chats/chat-1/messages/rating-request")));
  await assertSucceeds(getDoc(doc(renterDb, "chats/chat-1/messages/legacy-message")));
  await assertFails(getDoc(doc(otherDb, "chats/chat-1/messages/rating-request")));
});

test("archived chat participants cannot create messages", async () => {
  const renterDb = testEnv.authenticatedContext("renter").firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await updateDoc(doc(db, "userChats/renter/chats/chat-1"), { status: "Archived" });
  });

  await assertFails(setDoc(doc(renterDb, "chats/chat-1/messages/message-archived"), {
    id: "message-archived",
    text: "This should be blocked",
    senderId: "renter",
    visibleTo: ["renter", "owner"],
  }));
});

test("blocked users can message only while booking coordination is required", async () => {
  const renterDb = testEnv.authenticatedContext("renter").firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "users/renter/blockExclusions/owner"), { otherUid: "owner" });
  });

  await assertSucceeds(setDoc(doc(renterDb, "chats/chat-1/messages/message-active-block"), {
    id: "message-active-block",
    text: "Booking coordination",
    senderId: "renter",
    visibleTo: ["renter", "owner"],
  }));

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await updateDoc(doc(db, "userChats/renter/chats/chat-1"), { bookingStatus: "Completed" });
  });

  await assertFails(setDoc(doc(renterDb, "chats/chat-1/messages/message-terminal-block"), {
    id: "message-terminal-block",
    text: "No longer allowed",
    senderId: "renter",
    visibleTo: ["renter", "owner"],
  }));
});

test("users can read but cannot write their block exclusions", async () => {
  const renterDb = testEnv.authenticatedContext("renter").firestore();
  const ownerDb = testEnv.authenticatedContext("owner").firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "users/renter/blockExclusions/owner"), { otherUid: "owner" });
  });

  await assertSucceeds(getDocs(collection(renterDb, "users/renter/blockExclusions")));
  await assertFails(getDocs(collection(ownerDb, "users/renter/blockExclusions")));
  await assertFails(setDoc(doc(renterDb, "users/renter/blockExclusions/other"), { otherUid: "other" }));
});

test("storage listing uploads are scoped to the authenticated user", async () => {
  const ownerStorage = testEnv.authenticatedContext("owner").storage();
  const otherStorage = testEnv.authenticatedContext("other").storage();
  const guestStorage = testEnv.unauthenticatedContext().storage();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await uploadString(ref(context.storage(), "owner/posts/images/legacy.jpg"), "image");
    await uploadString(ref(context.storage(), "listings/asset-1/images/photo.jpg"), "image");
  });

  await assertFails(uploadString(ref(ownerStorage, "owner/posts/images/photo.jpg"), "image"));
  await assertSucceeds(uploadString(ref(ownerStorage, "users/owner/listingDrafts/draft-1/images/photo.jpg"), "image"));
  await assertSucceeds(getBytes(ref(ownerStorage, "users/owner/listingDrafts/draft-1/images/photo.jpg")));
  await assertFails(getBytes(ref(guestStorage, "users/owner/listingDrafts/draft-1/images/photo.jpg")));
  await assertSucceeds(getBytes(ref(guestStorage, "owner/posts/images/legacy.jpg")));
  await assertSucceeds(getBytes(ref(guestStorage, "listings/asset-1/images/photo.jpg")));
  await assertFails(uploadString(ref(otherStorage, "users/owner/listingDrafts/draft-1/images/hijack.jpg"), "image"));
  await assertFails(uploadString(ref(ownerStorage, "listings/asset-1/images/hijack.jpg"), "image"));
});

test("storage listing deactivation evidence uploads are scoped to the authenticated user", async () => {
  const ownerStorage = testEnv.authenticatedContext("owner").storage();
  const otherStorage = testEnv.authenticatedContext("other").storage();
  const guestStorage = testEnv.unauthenticatedContext().storage();
  const evidencePath = "users/owner/listingDeactivationRequests/request-1/evidence/photo.jpg";

  await assertSucceeds(uploadString(ref(ownerStorage, evidencePath), "image"));
  await assertSucceeds(getBytes(ref(ownerStorage, evidencePath)));
  await assertFails(uploadString(ref(otherStorage, evidencePath), "blocked"));
  await assertFails(getBytes(ref(guestStorage, evidencePath)));
});

test("storage business registration uploads are owner/admin readable", async () => {
  const ownerStorage = testEnv.authenticatedContext("owner").storage();
  const renterStorage = testEnv.authenticatedContext("renter").storage();
  const otherStorage = testEnv.authenticatedContext("other").storage();
  const adminStorage = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).storage();
  const guestStorage = testEnv.unauthenticatedContext().storage();
  const documentPath = "users/owner/businessRegistration/dti.jpg";

  await assertSucceeds(uploadString(ref(ownerStorage, documentPath), "image"));
  await assertSucceeds(getBytes(ref(ownerStorage, documentPath)));
  await assertSucceeds(getBytes(ref(adminStorage, documentPath)));
  await assertSucceeds(uploadString(ref(renterStorage, "users/renter/businessRegistration/dti.jpg"), "image"));
  await assertFails(uploadString(ref(otherStorage, documentPath), "blocked"));
  await assertFails(getBytes(ref(guestStorage, documentPath)));
});

test("basic users can upload business registration documents for verification", async () => {
  const ownerStorage = testEnv.authenticatedContext("owner").storage();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await updateDoc(doc(context.firestore(), "users/owner"), {
      verified: "Basic",
    });
  });

  await assertSucceeds(uploadString(
    ref(ownerStorage, "users/owner/businessRegistration/dti-basic.jpg"),
    "image",
  ));
});

test("storage chat uploads are scoped to the authenticated user's path", async () => {
  const renterStorage = testEnv.authenticatedContext("renter").storage();
  const otherStorage = testEnv.authenticatedContext("other").storage();
  const guestStorage = testEnv.unauthenticatedContext().storage();

  await assertSucceeds(uploadString(ref(renterStorage, "renter/chats/chat-1/message.txt"), "hello"));
  await assertFails(uploadString(ref(otherStorage, "renter/chats/chat-1/blocked.txt"), "blocked"));
  await assertFails(getBytes(ref(guestStorage, "renter/chats/chat-1/message.txt")));
});

async function seedFirestore() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    await setDoc(doc(db, "users/owner"), { uid: "owner", firstName: "Owner", verified: "Full" });
    await setDoc(doc(db, "users/renter"), { uid: "renter", firstName: "Renter", verified: "Basic" });
    await setDoc(doc(db, "users/other"), { uid: "other", firstName: "Other", verified: "None" });
    await setDoc(doc(db, "assets/asset-1"), assetData("owner"));
    await setDoc(doc(db, "users/owner/assets/asset-1"), simpleAssetData("owner"));
    await setDoc(doc(db, "assets/asset-1/bookings/booking-1"), bookingData());
    await setDoc(doc(db, "users/renter/bookings/booking-1"), bookingData());
    await setDoc(doc(db, "chats/chat-1"), { chatType: "Private" });
    await setDoc(doc(db, "chats/chat-1/messages/message-1"), {
      id: "message-1",
      text: "Booking Received!",
      senderId: "owner",
      visibleTo: ["renter", "owner"],
    });
    await setDoc(doc(db, "chats/chat-1/messages/legacy-message"), {
      id: "legacy-message",
      text: "Missing visibility",
      senderId: "owner",
    });
    await setDoc(doc(db, "chats/chat-1/messages/rating-request"), {
      id: "rating-request",
      text: "Rate this booking",
      senderId: "",
      type: "rating",
      visibleTo: ["renter"],
    });
    await setDoc(doc(db, "userChats/owner/chats/chat-1"), {
      id: "chat-1",
      bookingId: "booking-1",
      participantIds: ["owner", "renter"],
      otherParticipantId: "renter",
      bookingStatus: "Pending",
      status: "Active",
    });
    await setDoc(doc(db, "userChats/renter/chats/chat-1"), {
      id: "chat-1",
      bookingId: "booking-1",
      participantIds: ["owner", "renter"],
      otherParticipantId: "owner",
      bookingStatus: "Pending",
      status: "Active",
    });
  });
}

function assetData(ownerId) {
  return {
    id: `asset-${ownerId}`,
    ownerId,
    owner: {
      uid: ownerId,
      firstName: "Owner",
      verified: "Full",
    },
    title: "Camera",
    isDeleted: false,
    status: "Available",
  };
}

function simpleAssetData(ownerId) {
  return {
    id: "asset-1",
    owner: {
      uid: ownerId,
      firstName: "Owner",
      verified: "Full",
    },
    title: "Camera",
    isDeleted: false,
    status: "Available",
  };
}

function auditData(type) {
  return {
    type,
    notes: "Incomplete listing details",
    createdBy: {
      uid: "admin",
      name: "Admin User",
    },
    createdAt: new Date("2026-04-02T00:00:00.000Z"),
  };
}

function accountFeedbackData(id, overrides = {}) {
  return {
    id,
    action: "delete",
    reason: "No longer need Lend",
    feedback: "Optional product feedback",
    createdAt: new Date("2026-04-02T00:00:00.000Z"),
    ...overrides,
  };
}

function contactMessageData(overrides = {}) {
  return {
    name: "Lend User",
    email: "user@example.com",
    subject: "Booking help",
    message: "I need help with a booking.",
    source: "contact_us_web",
    status: "Open",
    createdAt: new Date("2026-06-17T01:00:00.000Z"),
    ...overrides,
  };
}

function earlyAccessSignupData(overrides = {}) {
  return {
    email: "user@example.com",
    emailHash: "a".repeat(64),
    emailedAt: null,
    emailedBy: null,
    source: "early_access_web",
    status: "Pending",
    createdAt: new Date("2026-06-17T01:00:00.000Z"),
    ...overrides,
  };
}

function earlyAccessRateLimitData(overrides = {}) {
  return {
    attemptCount: 1,
    updatedAt: new Date("2026-06-17T01:00:00.000Z"),
    windowStartedAt: new Date("2026-06-17T01:00:00.000Z"),
    ...overrides,
  };
}

function notificationData(overrides = {}) {
  return {
    title: "Verification approved",
    body: "Your full verification has been approved.",
    type: "verification",
    data: {
      type: "verification",
      status: "Approved",
    },
    readAt: null,
    createdAt: new Date("2026-04-02T00:00:00.000Z"),
    ...overrides,
  };
}

function legalContentPageData(slug, overrides = {}) {
  return {
    slug,
    title: "Terms and Conditions",
    description: "Legal terms",
    effectiveDate: "June 17, 2026",
    lastUpdated: "June 17, 2026",
    draftMarkdown: "# Terms",
    publishedMarkdown: "# Terms",
    draftUpdatedAt: new Date("2026-06-17T00:00:00.000Z"),
    draftUpdatedBy: adminActor(),
    publishedAt: new Date("2026-06-17T00:00:00.000Z"),
    publishedBy: adminActor(),
    ...overrides,
  };
}

function helpCenterContentPageData(overrides = {}) {
  return {
    slug: "help-center",
    title: "Help Center",
    description: "Help content",
    draftTopics: [{ id: "getting-started", label: "Getting started", sortOrder: 10 }],
    publishedTopics: [{ id: "getting-started", label: "Getting started", sortOrder: 10 }],
    draftQuestions: [
      {
        id: "what-is-lend",
        topicId: "getting-started",
        question: "What is Lend?",
        answerMarkdown: "Lend is a marketplace.",
        sortOrder: 10,
        isPublished: true,
      },
    ],
    publishedQuestions: [
      {
        id: "what-is-lend",
        topicId: "getting-started",
        question: "What is Lend?",
        answerMarkdown: "Lend is a marketplace.",
        sortOrder: 10,
        isPublished: true,
      },
    ],
    draftUpdatedAt: new Date("2026-06-17T00:00:00.000Z"),
    draftUpdatedBy: adminActor(),
    publishedAt: new Date("2026-06-17T00:00:00.000Z"),
    publishedBy: adminActor(),
    ...overrides,
  };
}

function adminActor() {
  return { id: "admin", name: "Admin" };
}

function amenityData(id, overrides = {}) {
  return {
    appliesToDetailSchemaKeys: ["space", "stay"],
    createdAt: new Date("2026-04-02T00:00:00.000Z"),
    createdBy: "admin",
    group: "Property",
    iconKey: "wifi",
    isActive: true,
    label: id,
    sortOrder: 10,
    updatedAt: new Date("2026-04-02T00:00:00.000Z"),
    updatedBy: "admin",
    ...overrides,
  };
}

function verificationSummaryData(submissionId) {
  return {
    status: "Pending",
    activeSubmissionId: submissionId,
    submittedAt: new Date("2026-04-02T00:00:00.000Z"),
    reviewedAt: null,
  };
}

function ownerInviteData(overrides = {}) {
  return {
    adminNotes: null,
    claimCount: 0,
    claimedAt: null,
    claimedByUid: null,
    code: "JUAN-8K2",
    codeHash: "hash",
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    createdBy: "admin",
    displayName: "Juan Camera Rentals",
    expiresAt: new Date("2026-09-20T00:00:00.000Z"),
    lastOpenedAt: null,
    maxClaims: 1,
    openCount: 0,
    perks: ["Founding Owner badge"],
    slug: "juan-camera-rentals",
    status: "Active",
    targetCategory: "Camera gear",
    targetLocation: "Cebu City",
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedBy: "admin",
    ...overrides,
  };
}

function foundingOwnerData(overrides = {}) {
  return {
    claimedAt: new Date("2026-06-20T00:00:00.000Z"),
    code: "JUAN-8K2",
    displayName: "Juan Camera Rentals",
    inviteCode: "JUAN-8K2",
    inviteId: "juan-camera-rentals",
    inviteSlug: "juan-camera-rentals",
    perks: ["Founding Owner badge"],
    slug: "juan-camera-rentals",
    status: "Claimed",
    targetCategory: "Camera gear",
    targetLocation: "Cebu City",
    ...overrides,
  };
}

function verificationSubmissionData(id, userId, overrides = {}) {
  return {
    id,
    userId,
    firstName: "Owner",
    lastName: "User",
    dateOfBirth: new Date("1995-01-01T00:00:00.000Z"),
    email: "owner@example.com",
    phone: "09171234567",
    address: "Makati City",
    location: {
      formattedAddress: "Makati City",
      locality: "Makati",
      administrativeAreaLevel1: "Metro Manila",
      country: "Philippines",
      countryShortName: "PH",
      lat: 14.5547,
      lng: 121.0244,
      geohash: "wdw4f",
    },
    photoUrl: null,
    faceKycStatus: "Submitted",
    verificationProvider: "didit",
    diditSessionId: null,
    diditWorkflowId: null,
    diditStatus: "Submitted",
    diditDecision: null,
    diditStartedAt: null,
    diditCompletedAt: null,
    status: "Pending",
    submittedAt: new Date("2026-04-02T00:00:00.000Z"),
    reviewedAt: null,
    ...overrides,
  };
}

function businessRegistrationSubmissionData(ownerId, overrides = {}) {
  return {
    ownerId,
    status: "Pending",
    documents: {
      dti: `users/${ownerId}/businessRegistration/dti.jpg`,
      bir: `users/${ownerId}/businessRegistration/bir.jpg`,
      mayorBusinessPermit: `users/${ownerId}/businessRegistration/permit.jpg`,
    },
    taxInvoiceAcknowledged: true,
    requestedListingReviewSubmissionId: "submission-1",
    submittedAt: new Date("2026-06-09T01:00:00.000Z"),
    updatedAt: new Date("2026-06-09T01:00:00.000Z"),
    ...overrides,
  };
}

function bookingData() {
  return {
    id: "booking-1",
    chatId: "chat-1",
    asset: {
      id: "asset-1",
      owner: {
        uid: "owner",
        verified: "Full",
      },
    },
    renter: {
      uid: "renter",
      verified: "Basic",
    },
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    startDate: new Date("2026-04-10T00:00:00.000Z"),
    endDate: new Date("2026-04-12T00:00:00.000Z"),
    numDays: 2,
    totalPrice: 1000,
    status: "Pending",
    tokens: null,
  };
}

assert.ok(projectId);
