const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const { getStorageBucket } = require("../utils/storageBucket.util");
const {
  LISTING_REVIEW_STATUS,
  approveQueuedSubmission,
  assertImageRefsAllowed,
  assertOwnerCanSubmit,
  assertOwnerPayoutDestinationConfigured,
  buildOwnerComplianceRisk,
  buildInitialReviewSubmissionData,
  buildListingReviewNotification,
  deleteDraftImages,
  hydrateAndAssertCategoryMetadata,
  normalizeListingSubmission,
  verifyDraftImages,
} = require("./listingModeration.util");
const { sendNotificationToUser } = require("../utils/notification.util");

exports.submitListingForReview = async (request) => {
  const db = admin.firestore();
  const bucket = getStorageBucket();
  const uid = request.auth?.uid;

  if (!uid) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  try {
    const submission = normalizeListingSubmission(request.data, uid);
    await hydrateAndAssertCategoryMetadata({ db, submission });
    const existingAsset = await assertOwnerCanSubmit({ db, uid, submission });
    await assertOwnerPayoutDestinationConfigured({ db, uid });
    const imagePaths = submission.images.concat(submission.showcase);
    assertImageRefsAllowed({ uid, submission, existingAsset });

    await verifyDraftImages({ bucket, paths: imagePaths });
    const ownerComplianceRisk = await buildOwnerComplianceRisk({
      db,
      uid,
      submission,
      now: new Date(),
    });
    const submissionRef = db.collection("listingReviewSubmissions").doc();
    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
    await submissionRef.set(
      buildInitialReviewSubmissionData({
        submissionId: submissionRef.id,
        submission,
        uid,
        now,
        ownerComplianceRisk,
      }),
    );
    return {
      accepted: true,
      submissionId: submissionRef.id,
      status: LISTING_REVIEW_STATUS.queued,
    };
  } catch (error) {
    console.error(`[submitListingForReview] Error: ${error.message}`);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throwAndLogHttpsError("internal", "Unable to review listing");
  }
};

exports.reviewListingSubmission = async (request) => {
  const db = admin.firestore();
  const bucket = getStorageBucket();
  const uid = request.auth?.uid;
  const token = request.auth?.token || {};

  if (!uid || token.admin !== true) {
    throwAndLogHttpsError("permission-denied", "Admin access is required");
  }

  try {
    const data = request.data && typeof request.data === "object" ? request.data : {};
    const submissionId = typeof data.submissionId === "string" ? data.submissionId.trim() : "";
    const decision = typeof data.decision === "string" ? data.decision.trim() : "";
    const notes = typeof data.notes === "string" ? data.notes.trim().slice(0, 2000) : "";

    if (!submissionId || !["approve", "reject"].includes(decision)) {
      throwAndLogHttpsError("invalid-argument", "Missing listing review decision");
    }

    const submissionRef = db.collection("listingReviewSubmissions").doc(submissionId);
    const submissionSnap = await submissionRef.get();
    if (!submissionSnap.exists) {
      throwAndLogHttpsError("not-found", "Listing review submission was not found");
    }

    const queueItem = submissionSnap.data();
    if (queueItem.status !== LISTING_REVIEW_STATUS.pending) {
      throwAndLogHttpsError("failed-precondition", "Listing review submission is already reviewed");
    }

    const adminUser = {
      uid,
      name: token.name || token.email || uid,
    };
    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();

    if (decision === "reject") {
      await rejectQueuedSubmission({
        adminUser,
        notes,
        now,
        queueItem,
        submissionId,
        submissionRef,
      });
      return { decision: "reject", submissionId };
    }

    const result = await approveQueuedSubmission({
      db,
      bucket,
      queueItem: { ...queueItem, id: submissionId },
      adminUser,
      notes,
    });
    return { decision: "approve", submissionId, assetId: result.listingId };
  } catch (error) {
    console.error(`[reviewListingSubmission] Error: ${error.message}`);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throwAndLogHttpsError("internal", "Unable to review listing submission");
  }
};

async function rejectQueuedSubmission({
  adminUser,
  notes,
  now,
  queueItem,
  sendNotificationToUserImpl = sendNotificationToUser,
  submissionId,
  submissionRef,
}) {
  await submissionRef.set(
    {
      status: LISTING_REVIEW_STATUS.rejected,
      reviewedAt: now,
      updatedAt: now,
      reviewedBy: adminUser,
      adminNotes: notes,
    },
    { merge: true },
  );
  await sendNotificationToUserImpl(
    buildListingReviewNotification({
      queueItem,
      submissionId,
    }),
  );
}

exports.deleteListingReviewSubmission = async (request) => {
  const db = admin.firestore();
  const bucket = getStorageBucket();
  const uid = request.auth?.uid;

  if (!uid) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  try {
    const data = request.data && typeof request.data === "object" ? request.data : {};
    const submissionId = typeof data.submissionId === "string" ? data.submissionId.trim() : "";
    if (!submissionId) {
      throwAndLogHttpsError("invalid-argument", "Missing listing review submission");
    }

    const submissionRef = db.collection("listingReviewSubmissions").doc(submissionId);
    const submissionSnap = await submissionRef.get();
    if (!submissionSnap.exists) {
      throwAndLogHttpsError("not-found", "Listing review submission was not found");
    }

    const queueItem = submissionSnap.data();
    if (queueItem.ownerId !== uid) {
      throwAndLogHttpsError("permission-denied", "You can only delete your own review submission");
    }
    if (queueItem.status !== LISTING_REVIEW_STATUS.rejected) {
      throwAndLogHttpsError("failed-precondition", "Only rejected review submissions can be deleted");
    }

    await deleteDraftImages({ bucket, submission: queueItem.listing });
    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
    await submissionRef.set(
      {
        status: LISTING_REVIEW_STATUS.deleted,
        deletedAt: now,
        updatedAt: now,
      },
      { merge: true },
    );

    return { deleted: true, submissionId };
  } catch (error) {
    console.error(`[deleteListingReviewSubmission] Error: ${error.message}`);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throwAndLogHttpsError("internal", "Unable to delete listing review submission");
  }
};

exports._test = {
  rejectQueuedSubmission,
};
