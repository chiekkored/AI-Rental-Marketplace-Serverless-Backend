const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { reviewListingLocalRules } = require("./localRules");
const {
  isTransientOpenAiModerationError,
  reviewListingOpenAiModeration,
} = require("./openaiModeration");
const { getStorageBucket } = require("../utils/storageBucket.util");
const { sendNotificationToUser } = require("../utils/notification.util");
const { FUNCTIONS_REGION } = require("../utils/functionsRegion.util");
const { getListingReviewBypassAiConfig } = require("../utils/remoteConfig.util");
const {
  LISTING_REVIEW_STATUS,
  buildImageReviewUrls,
  buildListingApprovedNotification,
  buildListingReviewNotification,
  buildOwnerComplianceManualReview,
  buildReviewQueueData,
  createOrUpdatePublicListing,
} = require("./listingModeration.util");

const PROVIDER_MODERATION_UNAVAILABLE_CATEGORY = "provider_moderation_unavailable";
const PROVIDER_BUSINESS_REVIEW_UNAVAILABLE_CATEGORY = "provider_business_review_unavailable";
const DEFAULT_GEMINI_REVIEW_MAX_ATTEMPTS = 3;
const GEMINI_REVIEW_BASE_RETRY_MS = 250;
const GEMINI_REVIEW_MAX_RETRY_MS = 2000;
const TRANSIENT_GEMINI_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_GEMINI_ERROR_CODES = new Set([
  "aborted",
  "deadline-exceeded",
  "resource-exhausted",
  "unavailable",
  "internal",
  "ABORTED",
  "DEADLINE_EXCEEDED",
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
  "INTERNAL",
]);

exports.processListingReviewSubmission = onDocumentCreated(
  {
    document: "listingReviewSubmissions/{submissionId}",
    region: FUNCTIONS_REGION,
  },
  (event) => processListingReviewSubmissionEvent(event),
);

async function processListingReviewSubmissionEvent(event) {
  const snapshot = event.data;
  const submissionId = event.params.submissionId;
  const queueItem = snapshot.data();

  if (!queueItem || queueItem.status !== LISTING_REVIEW_STATUS.queued) {
    return null;
  }

  const db = admin.firestore();
  const bucket = getStorageBucket();
  const submission = queueItem.listing;
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();

  await snapshot.ref.set(
    {
      status: LISTING_REVIEW_STATUS.processing,
      updatedAt: now,
      processingStartedAt: now,
    },
    { merge: true },
  );

  try {
    if (queueItem.ownerComplianceRisk?.triggered === true) {
      const review = buildOwnerComplianceManualReview(queueItem.ownerComplianceRisk);
      await snapshot.ref.set(
        buildReviewQueueData({
          submissionId,
          submission,
          review,
          uid: queueItem.ownerId,
          now: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
          ownerComplianceRisk: queueItem.ownerComplianceRisk,
        }),
        { merge: true },
      );
      return null;
    }

    const bypassAiReview = await getListingReviewBypassAiConfig();
    const review = bypassAiReview
      ? buildBypassedAiReview()
      : await runListingReviewPipeline({ bucket, submission });

    if (review.decision === "approve") {
      const ownerSnap = await db.collection("users").doc(queueItem.ownerId).get();
      const existingAsset =
        submission.submissionType === "update"
          ? (await db.collection("assets").doc(submission.assetId).get()).data()
          : null;
      const result = await createOrUpdatePublicListing({
        db,
        bucket,
        submission,
        owner: ownerSnap.data(),
        review,
        existingAsset,
      });
      await snapshot.ref.set(
        {
          aiReview: review,
          status: LISTING_REVIEW_STATUS.approved,
          reviewedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
          updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
          approvedAssetId: result.listingId,
        },
        { merge: true },
      );
      await sendNotificationToUser(
        buildListingApprovedNotification({
          queueItem,
          assetId: result.listingId,
        }),
      );
      return null;
    }

    if (review.decision === "manual_review") {
      await snapshot.ref.set(
        buildReviewQueueData({
          submissionId,
          submission,
          review,
          uid: queueItem.ownerId,
          now: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
          ownerComplianceRisk: queueItem.ownerComplianceRisk || null,
        }),
        { merge: true },
      );
      return null;
    }

    const rejectedItem = {
      ...queueItem,
      aiReview: review,
      status: LISTING_REVIEW_STATUS.rejected,
    };
    await snapshot.ref.set(
      {
        aiReview: review,
        status: LISTING_REVIEW_STATUS.rejected,
        reviewedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      },
      { merge: true },
    );
    await sendNotificationToUser(buildListingReviewNotification({ queueItem: rejectedItem, submissionId }));
    return null;
  } catch (error) {
    console.error(`[processListingReviewSubmission] Error: ${error.message}`);
    await snapshot.ref.set(
      {
        status: LISTING_REVIEW_STATUS.queued,
        processingError: error.message || "Unable to process listing review",
        updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      },
      { merge: true },
    );
    return null;
  }
}

exports._test = {
  buildGeminiUnavailableManualReview,
  buildOpenAiUnavailableManualReview,
  buildBypassedAiReview,
  isTransientGeminiReviewError,
  processListingReviewSubmissionEvent,
  retryGeminiListingReview,
  runGeminiListingReview,
  runListingReviewPipeline,
};

async function runListingReviewPipeline({
  bucket,
  buildImageReviewUrlsImpl = buildImageReviewUrls,
  geminiReviewImpl = runGeminiListingReview,
  geminiMaxAttempts = DEFAULT_GEMINI_REVIEW_MAX_ATTEMPTS,
  localReviewImpl = reviewListingLocalRules,
  openAiReviewImpl = reviewListingOpenAiModeration,
  randomImpl = Math.random,
  sleepImpl = sleep,
  submission,
}) {
  const localReview = localReviewImpl(submission);
  if (localReview) return localReview;

  const openAiReview = await openAiReviewImpl({
    bucket,
    buildImageReviewUrls: buildImageReviewUrlsImpl,
    submission,
  }).catch((error) => {
    if (isTransientOpenAiModerationError(error)) {
      return buildOpenAiUnavailableManualReview(error);
    }
    throw error;
  });
  if (openAiReview.decision !== "approve") return openAiReview;

  const geminiReview = await retryGeminiListingReview({
    geminiReviewImpl,
    maxAttempts: geminiMaxAttempts,
    randomImpl,
    sleepImpl,
    submission,
  }).catch((error) => {
    if (isTransientGeminiReviewError(error)) {
      return buildGeminiUnavailableManualReview(error);
    }
    throw error;
  });
  return {
    ...geminiReview,
    providerResults: {
      ...(openAiReview.providerResults || {}),
      ...(geminiReview.providerResults || {}),
      geminiTextReview: {
        ...(geminiReview.providerResults?.geminiTextReview || {}),
        decision: geminiReview.decision,
        categories: geminiReview.categories || [],
        severity: geminiReview.severity || null,
      },
    },
  };
}

async function retryGeminiListingReview({
  geminiReviewImpl = runGeminiListingReview,
  maxAttempts = DEFAULT_GEMINI_REVIEW_MAX_ATTEMPTS,
  randomImpl = Math.random,
  sleepImpl = sleep,
  submission,
}) {
  let lastError = null;
  const attempts = Math.max(1, Number(maxAttempts) || DEFAULT_GEMINI_REVIEW_MAX_ATTEMPTS);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await geminiReviewImpl({ submission });
    } catch (error) {
      if (!isTransientGeminiReviewError(error) || attempt >= attempts) {
        throw error;
      }
      lastError = error;
      await sleepImpl(resolveRetryDelayMs({ attempt, randomImpl }));
    }
  }

  throw lastError || new Error("Gemini listing review failed");
}

async function runGeminiListingReview({ submission }) {
  const { reviewListingFlow } = require("./reviewListingFlow");

  return reviewListingFlow({
    submissionType: submission.submissionType,
    title: submission.title,
    description: submission.description,
    categoryName: submission.categoryName,
    subcategoryName: submission.subcategoryName || null,
    listingKind: submission.listingKind || null,
    detailSchemaKey: submission.detailSchemaKey || null,
    details: submission.details || {},
    rates: submission.rates,
    inclusions: submission.inclusions,
    ownerInstructions: submission.ownerInstructions,
    securityDeposit: submission.securityDeposit,
  });
}

function buildOpenAiUnavailableManualReview(error) {
  return {
    decision: "manual_review",
    severity: "medium",
    categories: [PROVIDER_MODERATION_UNAVAILABLE_CATEGORY],
    reasons: ["OpenAI moderation was temporarily unavailable; admin review required."],
    providerResults: {
      openaiModeration: {
        error: {
          body: error.body || "",
          isTransient: true,
          retryAfterMs: Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : null,
          status: error.status || null,
        },
      },
    },
  };
}

function buildGeminiUnavailableManualReview(error) {
  return {
    decision: "manual_review",
    severity: "medium",
    categories: [PROVIDER_BUSINESS_REVIEW_UNAVAILABLE_CATEGORY],
    reasons: ["Gemini listing review was temporarily unavailable; admin review required."],
    providerResults: {
      geminiTextReview: {
        error: sanitizeGeminiError(error),
      },
    },
  };
}

function buildBypassedAiReview() {
  return {
    decision: "approve",
    severity: "low",
    categories: [],
    reasons: ["Listing review bypassed by admin configuration."],
    providerResults: {
      bypass: {
        localRules: true,
        openaiModeration: true,
        geminiTextReview: true,
      },
    },
  };
}

function isTransientGeminiReviewError(error) {
  const status = readErrorStatus(error);
  if (TRANSIENT_GEMINI_STATUS_CODES.has(status)) return true;

  const code = readErrorCode(error);
  if (TRANSIENT_GEMINI_ERROR_CODES.has(code)) return true;

  const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  return /\b(429|500|502|503|504|rate limit|quota|resource exhausted|deadline|timeout|timed out|unavailable|overloaded|internal error)\b/.test(
    message,
  );
}

function sanitizeGeminiError(error) {
  return {
    body: typeof error?.message === "string" ? error.message.trim().slice(0, 1000) : "",
    code: readErrorCode(error) || null,
    isTransient: true,
    status: readErrorStatus(error) || null,
  };
}

function readErrorStatus(error) {
  const candidates = [
    error?.status,
    error?.statusCode,
    error?.code,
    error?.cause?.status,
    error?.cause?.statusCode,
    error?.response?.status,
    error?.response?.statusCode,
  ];
  for (const candidate of candidates) {
    const status = Number(candidate);
    if (Number.isInteger(status)) return status;
  }
  return null;
}

function readErrorCode(error) {
  const candidates = [error?.code, error?.statusText, error?.cause?.code, error?.details?.code];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function resolveRetryDelayMs({ attempt, randomImpl = Math.random }) {
  const jitter = Math.floor((typeof randomImpl === "function" ? randomImpl() : Math.random()) * 100);
  const exponentialDelay = GEMINI_REVIEW_BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponentialDelay + jitter, GEMINI_REVIEW_MAX_RETRY_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
