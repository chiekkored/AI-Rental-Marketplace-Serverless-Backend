const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { firstListingImageUrl, sendNotificationToUser } = require("../utils/notification.util");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  LISTING_REVIEW_STATUS,
  hasApprovedBusinessRegistration,
} = require("../listing-review/listingModeration.util");

const COMPLIANCE_REVIEW_CATEGORY = "owner_compliance_document_review";
const BUSINESS_REGISTRATION_STATUS = {
  notSubmitted: "Not Submitted",
  required: "Required",
  submitted: "Submitted",
  approved: "Approved",
};
const BUSINESS_REGISTRATION_VISIBILITY_REASON = {
  adminRequest: "admin_request",
  ownerSelfDeclared: "owner_self_declared",
};

exports.requestListingComplianceDocuments = async (request) => {
  const db = admin.firestore();
  const uid = request.auth?.uid;
  const token = request.auth?.token || {};

  if (!uid || token.admin !== true) {
    throwAndLogHttpsError("permission-denied", "Admin access is required");
  }

  try {
    const input = normalizeRequestListingComplianceDocumentsInput(request.data);
    const submissionRef = db.collection("listingReviewSubmissions").doc(input.submissionId);
    const submissionSnap = await submissionRef.get();
    if (!submissionSnap.exists) {
      throwAndLogHttpsError("not-found", "Listing review submission was not found");
    }

    const queueItem = submissionSnap.data();
    assertCanRequestListingComplianceDocuments(queueItem);

    const ownerId = queueItem.ownerId;
    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
    const adminUser = {
      uid,
      name: token.name || token.email || uid,
    };

    await db.runTransaction(async (transaction) => {
      const latestSubmissionSnap = await transaction.get(submissionRef);
      if (!latestSubmissionSnap.exists) {
        throwAndLogHttpsError("not-found", "Listing review submission was not found");
      }
      const latestQueueItem = latestSubmissionSnap.data();
      assertCanRequestListingComplianceDocuments(latestQueueItem);

      const userRef = db.collection("users").doc(latestQueueItem.ownerId);
      const userSnap = await transaction.get(userRef);
      const userBusinessRegistration = userSnap.data()?.businessRegistration || {};
      assertOwnerNeedsComplianceDocuments(userSnap.data());
      const existingReasons = Array.isArray(userBusinessRegistration.visibilityReasons)
        ? userBusinessRegistration.visibilityReasons
        : [];

      transaction.set(
        submissionRef,
        buildListingReviewBusinessRegistrationRequestUpdate({
          adminUser,
          now,
          ownerId: latestQueueItem.ownerId,
        }),
        { merge: true },
      );
      transaction.set(
        userRef,
        buildUserBusinessRegistrationRequestUpdate({
          existingReasons,
          existingStatus: userBusinessRegistration.status,
          now,
          submissionId: input.submissionId,
        }),
        { merge: true },
      );
    });

    await sendNotificationToUser(
      buildBusinessRegistrationRequestNotification({
        imageUrl: firstListingImageUrl(queueItem.listing),
        ownerId,
        submissionId: input.submissionId,
      }),
    );

    return {
      success: true,
      ownerId,
      status: BUSINESS_REGISTRATION_STATUS.required,
      submissionId: input.submissionId,
    };
  } catch (error) {
    console.error(`[requestListingComplianceDocuments] Error: ${error.message}`);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throwAndLogHttpsError("internal", "Unable to request compliance documents");
  }
};

function normalizeRequestListingComplianceDocumentsInput(data) {
  const raw = data && typeof data === "object" ? data : {};
  const submissionId = typeof raw.submissionId === "string" ? raw.submissionId.trim() : "";
  if (!submissionId) {
    throwAndLogHttpsError("invalid-argument", "Missing listing review submission");
  }
  return { submissionId };
}

function assertCanRequestListingComplianceDocuments(queueItem) {
  if (!queueItem || typeof queueItem !== "object") {
    throwAndLogHttpsError("not-found", "Listing review submission was not found");
  }
  if (queueItem.status !== LISTING_REVIEW_STATUS.pending) {
    throwAndLogHttpsError("failed-precondition", "Listing review submission is not pending");
  }
  if (typeof queueItem.ownerId !== "string" || queueItem.ownerId.trim().length === 0) {
    throwAndLogHttpsError("failed-precondition", "Listing review submission has no owner");
  }
  if (!hasOwnerComplianceReview(queueItem)) {
    throwAndLogHttpsError("failed-precondition", "Compliance document review is not required for this listing");
  }
}

function hasOwnerComplianceReview(queueItem) {
  const categories = Array.isArray(queueItem.aiReview?.categories) ? queueItem.aiReview.categories : [];
  return queueItem.ownerComplianceRisk?.triggered === true || categories.includes(COMPLIANCE_REVIEW_CATEGORY);
}

function assertOwnerNeedsComplianceDocuments(user) {
  if (hasApprovedBusinessRegistration(user)) {
    throwAndLogHttpsError(
      "failed-precondition",
      "Owner already has approved business registration documents",
    );
  }
}

function buildListingReviewBusinessRegistrationRequestUpdate({ adminUser, now, ownerId }) {
  return {
    businessRegistrationRequest: {
      status: BUSINESS_REGISTRATION_STATUS.required,
      requestedAt: now,
      requestedBy: adminUser,
      ownerId,
    },
    updatedAt: now,
  };
}

function buildUserBusinessRegistrationRequestUpdate({ existingReasons = [], existingStatus, now, submissionId }) {
  const status =
    existingStatus === BUSINESS_REGISTRATION_STATUS.approved
      ? BUSINESS_REGISTRATION_STATUS.approved
      : existingStatus === BUSINESS_REGISTRATION_STATUS.submitted
      ? BUSINESS_REGISTRATION_STATUS.submitted
      : BUSINESS_REGISTRATION_STATUS.required;
  return {
    businessRegistration: {
      visible: true,
      required: true,
      status,
      visibilityReasons: uniqueStrings([
        ...existingReasons,
        BUSINESS_REGISTRATION_VISIBILITY_REASON.adminRequest,
      ]),
      requestedListingReviewSubmissionId: submissionId,
      requestedAt: now,
      updatedAt: now,
    },
  };
}

function buildBusinessRegistrationRequestNotification({ imageUrl, ownerId, submissionId }) {
  return {
    uid: ownerId,
    title: "Business registration required",
    body:
      "Your listing is still under review. Submit the required documents in Owner Center > Business Registration.",
    imageUrl,
    persist: true,
    push: true,
    data: {
      type: "business_registration",
      target: "businessRegistration",
      submissionId,
    },
  };
}

function uniqueStrings(values) {
  return values
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .filter((value, index, array) => array.indexOf(value) === index);
}

exports._test = {
  BUSINESS_REGISTRATION_STATUS,
  BUSINESS_REGISTRATION_VISIBILITY_REASON,
  buildBusinessRegistrationRequestNotification,
  buildListingReviewBusinessRegistrationRequestUpdate,
  buildUserBusinessRegistrationRequestUpdate,
  assertOwnerNeedsComplianceDocuments,
  hasOwnerComplianceReview,
  normalizeRequestListingComplianceDocumentsInput,
  uniqueStrings,
};
