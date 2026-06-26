const functions = require("firebase-functions");
const { FieldValue } = require("firebase-admin/firestore");
const admin = require("firebase-admin");
const { approveQueuedSubmission, LISTING_REVIEW_STATUS } = require("../../listing-review/listingModeration.util");
const { throwAndLogHttpsError } = require("../../utils/error.util");
const { getStorageBucket } = require("../../utils/storageBucket.util");
const { sendNotificationToUser } = require("../../utils/notification.util");

const BUSINESS_REGISTRATION_STATUS = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
};

const BUSINESS_REGISTRATION_REJECTION_REASON_CODES = new Set([
  "document_unreadable",
  "document_incomplete",
  "document_mismatch",
  "expired_or_invalid",
  "compliance_issue",
  "other",
]);

exports.reviewBusinessRegistrationSubmission = async (request) => {
  const db = admin.firestore();
  const bucket = getStorageBucket();
  const uid = request.auth?.uid;
  const token = request.auth?.token || {};

  if (!uid || token.admin !== true) {
    throwAndLogHttpsError("permission-denied", "Admin access is required");
  }

  try {
    const input = normalizeReviewBusinessRegistrationInput(request.data);
    const submissionRef = db.collection("businessRegistrationSubmissions").doc(input.ownerId);
    const submissionSnap = await submissionRef.get();

    if (!submissionSnap.exists) {
      throwAndLogHttpsError("not-found", "Business registration submission was not found");
    }

    const submission = submissionSnap.data();
    assertReviewableBusinessRegistrationSubmission(submission);

    const adminUser = {
      uid,
      name: token.name || token.email || uid,
    };
    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();

    await db.runTransaction(async (transaction) => {
      const latestSubmissionSnap = await transaction.get(submissionRef);
      if (!latestSubmissionSnap.exists) {
        throwAndLogHttpsError("not-found", "Business registration submission was not found");
      }

      const latestSubmission = latestSubmissionSnap.data();
      assertReviewableBusinessRegistrationSubmission(latestSubmission);

      const userRef = db.collection("users").doc(input.ownerId);
      const userSnap = await transaction.get(userRef);
      if (!userSnap.exists) {
        throwAndLogHttpsError("not-found", "User was not found");
      }
      if (input.action === BUSINESS_REGISTRATION_STATUS.approved) {
        await assertLinkedVerificationApproved({
          db,
          ownerId: input.ownerId,
          submission: latestSubmission,
          transaction,
        });
      }

      const summaryUpdate = buildBusinessRegistrationSummaryUpdate({
        action: input.action,
        adminUser,
        existingSummary: userSnap.data()?.businessRegistration || {},
        input,
        now,
      });

      transaction.set(
        submissionRef,
        buildSubmissionReviewUpdate({
          action: input.action,
          adminUser,
          input,
          now,
        }),
        { merge: true },
      );
      transaction.set(
        userRef,
        {
          businessRegistration: summaryUpdate,
          userMetadataVersion: FieldValue.increment(1),
        },
        { merge: true },
      );
    });

    let linkedListingApproval = null;
    if (input.action === BUSINESS_REGISTRATION_STATUS.approved && submission.requestedListingReviewSubmissionId) {
      linkedListingApproval = await maybeApproveLinkedListingReview({
        adminUser,
        bucket,
        db,
        submissionId: submission.requestedListingReviewSubmissionId,
      });
    }

    const notification =
      input.action === BUSINESS_REGISTRATION_STATUS.approved
        ? buildBusinessRegistrationApprovedNotification({
            businessName: input.businessName,
            ownerId: input.ownerId,
          })
        : buildBusinessRegistrationRejectedNotification({
            ownerId: input.ownerId,
          });
    await sendNotificationToUser(notification);

    return {
      ownerId: input.ownerId,
      status: input.action,
      linkedListingApproval,
      success: true,
    };
  } catch (error) {
    console.error(`[reviewBusinessRegistrationSubmission] Error: ${error.message}`);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throwAndLogHttpsError("internal", "Unable to review business registration submission");
  }
};

function normalizeReviewBusinessRegistrationInput(data) {
  const raw = data && typeof data === "object" ? data : {};
  const ownerId = typeof raw.ownerId === "string" ? raw.ownerId.trim() : "";
  const action = typeof raw.action === "string" ? raw.action.trim() : "";
  const input = { action, ownerId };

  if (!ownerId) {
    throwAndLogHttpsError("invalid-argument", "Missing business registration owner");
  }
  if (![BUSINESS_REGISTRATION_STATUS.approved, BUSINESS_REGISTRATION_STATUS.rejected].includes(action)) {
    throwAndLogHttpsError("invalid-argument", "Missing business registration review action");
  }
  if (action === BUSINESS_REGISTRATION_STATUS.approved) {
    input.businessName = cleanRequiredString(raw.businessName, "businessName", 160);
    input.businessType = cleanRequiredString(raw.businessType, "businessType", 120);
    input.businessAddress = cleanRequiredString(raw.businessAddress, "businessAddress", 240);
    input.rejectionReason = null;
    input.rejectionReasonCode = null;
  } else {
    input.businessName = null;
    input.businessType = null;
    input.businessAddress = null;
    input.rejectionReasonCode = cleanRejectionReasonCode(raw.rejectionReasonCode);
    input.rejectionReason = cleanRequiredString(raw.rejectionReason, "rejectionReason", 500);
  }

  return input;
}

function assertReviewableBusinessRegistrationSubmission(submission) {
  if (!submission || typeof submission !== "object") {
    throwAndLogHttpsError("not-found", "Business registration submission was not found");
  }
  if (submission.status !== BUSINESS_REGISTRATION_STATUS.pending) {
    throwAndLogHttpsError("failed-precondition", "Business registration submission is already reviewed");
  }
  if (typeof submission.ownerId !== "string" || submission.ownerId.trim().length === 0) {
    throwAndLogHttpsError("failed-precondition", "Business registration submission has no owner");
  }
}

async function assertLinkedVerificationApproved({ db, ownerId, submission, transaction }) {
  const verificationSubmissionId =
    typeof submission.verificationSubmissionId === "string"
      ? submission.verificationSubmissionId.trim()
      : "";
  if (!verificationSubmissionId) {
    return;
  }

  const verificationRef = db.collection("verificationSubmissions").doc(verificationSubmissionId);
  const verificationSnap = await transaction.get(verificationRef);
  if (!verificationSnap.exists) {
    throwAndLogHttpsError(
      "failed-precondition",
      "Approve the linked user verification before approving this business registration",
    );
  }

  const verification = verificationSnap.data() || {};
  if (verification.userId !== ownerId || verification.status !== "Approved") {
    throwAndLogHttpsError(
      "failed-precondition",
      "Approve the linked user verification before approving this business registration",
    );
  }
}

function buildSubmissionReviewUpdate({ action, adminUser, input, now }) {
  return {
    status: action,
    reviewedAt: now,
    reviewedBy: adminUser,
    rejectionReason: action === BUSINESS_REGISTRATION_STATUS.rejected ? input.rejectionReason : null,
    rejectionReasonCode: action === BUSINESS_REGISTRATION_STATUS.rejected ? input.rejectionReasonCode : null,
    businessName: action === BUSINESS_REGISTRATION_STATUS.approved ? input.businessName : null,
    businessType: action === BUSINESS_REGISTRATION_STATUS.approved ? input.businessType : null,
    businessAddress: action === BUSINESS_REGISTRATION_STATUS.approved ? input.businessAddress : null,
    updatedAt: now,
  };
}

function buildBusinessRegistrationSummaryUpdate({ action, adminUser, existingSummary, input, now }) {
  return {
    ...existingSummary,
    visible: true,
    required: existingSummary.required === true,
    status: action,
    businessName: action === BUSINESS_REGISTRATION_STATUS.approved ? input.businessName : null,
    businessType: action === BUSINESS_REGISTRATION_STATUS.approved ? input.businessType : null,
    businessAddress: action === BUSINESS_REGISTRATION_STATUS.approved ? input.businessAddress : null,
    reviewedAt: now,
    reviewedBy: adminUser,
    updatedAt: now,
  };
}

async function maybeApproveLinkedListingReview({ adminUser, bucket, db, submissionId }) {
  const submissionRef = db.collection("listingReviewSubmissions").doc(submissionId);
  const submissionSnap = await submissionRef.get();

  if (!submissionSnap.exists) {
    return { status: "missing", submissionId };
  }

  const queueItem = submissionSnap.data();
  if (queueItem.status !== LISTING_REVIEW_STATUS.pending) {
    return { status: queueItem.status || "unknown", submissionId };
  }

  const result = await approveQueuedSubmission({
    adminUser,
    bucket,
    db,
    notes: "Approved after business registration compliance review.",
    queueItem: { ...queueItem, id: submissionId },
  });

  return {
    assetId: result.listingId,
    status: LISTING_REVIEW_STATUS.approved,
    submissionId,
  };
}

function cleanRequiredString(value, fieldName, maxLength) {
  if (typeof value !== "string") {
    throwAndLogHttpsError("invalid-argument", `${fieldName} must be a string`);
  }

  const text = value.trim();
  if (!text || text.length > maxLength) {
    throwAndLogHttpsError("invalid-argument", `${fieldName} is invalid`);
  }

  return text;
}

function cleanRejectionReasonCode(value) {
  if (typeof value !== "string") {
    throwAndLogHttpsError("invalid-argument", "Business registration rejection reason is invalid");
  }

  const code = value.trim();
  if (!BUSINESS_REGISTRATION_REJECTION_REASON_CODES.has(code)) {
    throwAndLogHttpsError("invalid-argument", "Business registration rejection reason is invalid");
  }

  return code;
}

function buildBusinessRegistrationApprovedNotification({ businessName, ownerId }) {
  return {
    uid: ownerId,
    title: "Business registration approved",
    body:
      businessName && businessName.trim().length > 0
        ? `${businessName.trim()} is now approved on Lend.`
        : "Your business registration is now approved on Lend.",
    persist: true,
    push: true,
    data: {
      type: "business_registration",
      target: "businessRegistration",
      status: BUSINESS_REGISTRATION_STATUS.approved,
    },
  };
}

function buildBusinessRegistrationRejectedNotification({ ownerId }) {
  return {
    uid: ownerId,
    title: "Business registration rejected",
    body: "Your business registration was rejected. Open Lend to review your status.",
    persist: true,
    push: true,
    data: {
      type: "business_registration",
      target: "businessRegistrationRejection",
      status: BUSINESS_REGISTRATION_STATUS.rejected,
    },
  };
}

exports._test = {
  BUSINESS_REGISTRATION_STATUS,
  BUSINESS_REGISTRATION_REJECTION_REASON_CODES,
  assertReviewableBusinessRegistrationSubmission,
  assertLinkedVerificationApproved,
  buildBusinessRegistrationApprovedNotification,
  buildBusinessRegistrationRejectedNotification,
  buildBusinessRegistrationSummaryUpdate,
  buildSubmissionReviewUpdate,
  cleanRejectionReasonCode,
  normalizeReviewBusinessRegistrationInput,
};
