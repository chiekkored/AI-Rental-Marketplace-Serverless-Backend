const assert = require("node:assert/strict");
const test = require("node:test");

const { LISTING_REVIEW_STATUS } = require("../../listing-review/listingModeration.util");
const { OpenAiModerationError } = require("../../listing-review/openaiModeration");
const { _test } = require("../../listing-review/processListingReviewSubmission");

test("processListingReviewSubmission skips non-queued submissions before service calls", async () => {
  const writes = [];

  const result = await _test.processListingReviewSubmissionEvent({
    params: { submissionId: "submission-1" },
    data: {
      data: () => ({
        status: LISTING_REVIEW_STATUS.pending,
      }),
      ref: {
        set: async (payload) => writes.push(payload),
      },
    },
  });

  assert.equal(result, null);
  assert.deepEqual(writes, []);
});

test("processListingReviewSubmission skips empty snapshots before service calls", async () => {
  const writes = [];

  const result = await _test.processListingReviewSubmissionEvent({
    params: { submissionId: "submission-1" },
    data: {
      data: () => null,
      ref: {
        set: async (payload) => writes.push(payload),
      },
    },
  });

  assert.equal(result, null);
  assert.deepEqual(writes, []);
});

test("buildBypassedAiReview returns approved low-risk review", () => {
  const review = _test.buildBypassedAiReview();

  assert.equal(review.decision, "approve");
  assert.equal(review.severity, "low");
  assert.deepEqual(review.categories, []);
  assert.match(review.reasons[0], /bypassed/i);
  assert.equal(review.providerResults.bypass.localRules, true);
  assert.equal(review.providerResults.bypass.openaiModeration, true);
  assert.equal(review.providerResults.bypass.geminiTextReview, true);
});

function validSubmission(overrides = {}) {
  return {
    submissionType: "create",
    title: "Camera Kit",
    description: "Mirrorless camera for rent.",
    categoryId: "cameras",
    categoryName: "Cameras",
    subcategoryName: null,
    listingKind: "electronics",
    detailSchemaKey: "electronics",
    details: { brand: "Sony" },
    rates: { daily: 1200, currency: "PHP" },
    inclusions: ["Battery"],
    ownerInstructions: "",
    securityDeposit: { enabled: false, amount: 0 },
    images: ["users/owner/listingDrafts/draft-1/images/photo.jpg"],
    showcase: [],
    ...overrides,
  };
}

test("runListingReviewPipeline returns local rule rejection before provider calls", async () => {
  let openAiCalled = false;
  let geminiCalled = false;

  const review = await _test.runListingReviewPipeline({
    bucket: {},
    submission: validSubmission({ title: "VR" }),
    openAiReviewImpl: async () => {
      openAiCalled = true;
      return { decision: "approve", providerResults: {} };
    },
    geminiReviewImpl: async () => {
      geminiCalled = true;
      return { decision: "approve", severity: "low", categories: [], reasons: [] };
    },
  });

  assert.equal(review.decision, "reject");
  assert.equal(openAiCalled, false);
  assert.equal(geminiCalled, false);
});

test("runListingReviewPipeline rejects when OpenAI moderation flags content", async () => {
  let geminiCalled = false;

  const review = await _test.runListingReviewPipeline({
    bucket: {},
    submission: validSubmission(),
    openAiReviewImpl: async () => ({
      decision: "reject",
      severity: "medium",
      categories: ["adult_or_sexual_item"],
      reasons: ["OpenAI moderation flagged: sexual."],
      providerResults: { openaiModeration: { flaggedCategories: ["sexual"] } },
    }),
    geminiReviewImpl: async () => {
      geminiCalled = true;
      return { decision: "approve", severity: "low", categories: [], reasons: [] };
    },
  });

  assert.equal(review.decision, "reject");
  assert.deepEqual(review.categories, ["adult_or_sexual_item"]);
  assert.equal(geminiCalled, false);
});

test("runListingReviewPipeline calls Gemini text review after OpenAI approval", async () => {
  let openAiCalled = false;
  let geminiInput = null;

  const review = await _test.runListingReviewPipeline({
    bucket: {},
    submission: validSubmission(),
    openAiReviewImpl: async () => {
      openAiCalled = true;
      return {
        decision: "approve",
        severity: "low",
        categories: [],
        reasons: [],
        providerResults: { openaiModeration: { flaggedCategories: [] } },
      };
    },
    geminiReviewImpl: async (input) => {
      geminiInput = input;
      return {
        decision: "manual_review",
        severity: "medium",
        categories: ["stolen_or_suspicious_ownership"],
        reasons: ["Ownership needs admin review."],
      };
    },
  });

  assert.equal(openAiCalled, true);
  assert.equal(review.decision, "manual_review");
  assert.deepEqual(review.providerResults.openaiModeration.flaggedCategories, []);
  assert.equal(geminiInput.submission.title, "Camera Kit");
  assert.equal(Object.hasOwn(geminiInput, "imageReviewUrls"), false);
});

test("runListingReviewPipeline sends transient OpenAI errors to manual review", async () => {
  let geminiCalled = false;

  const review = await _test.runListingReviewPipeline({
    bucket: {},
    submission: validSubmission(),
    openAiReviewImpl: async () => {
      throw new OpenAiModerationError({
        body: '{"error":{"message":"Too Many Requests"}}',
        isTransient: true,
        message: "OpenAI moderation failed with HTTP 429",
        retryAfterMs: 1000,
        status: 429,
      });
    },
    geminiReviewImpl: async () => {
      geminiCalled = true;
      return { decision: "approve", severity: "low", categories: [], reasons: [] };
    },
  });

  assert.equal(review.decision, "manual_review");
  assert.deepEqual(review.categories, ["provider_moderation_unavailable"]);
  assert.match(review.reasons[0], /temporarily unavailable/i);
  assert.equal(review.providerResults.openaiModeration.error.status, 429);
  assert.equal(review.providerResults.openaiModeration.error.retryAfterMs, 1000);
  assert.equal(geminiCalled, false);
});

test("runListingReviewPipeline surfaces non-transient OpenAI errors", async () => {
  await assert.rejects(
    () =>
      _test.runListingReviewPipeline({
        bucket: {},
        submission: validSubmission(),
        openAiReviewImpl: async () => {
          throw new OpenAiModerationError({
            body: "Unauthorized",
            isTransient: false,
            message: "OpenAI moderation failed with HTTP 401",
            status: 401,
          });
        },
      }),
    /HTTP 401/,
  );
});

test("runListingReviewPipeline retries transient Gemini failures and succeeds", async () => {
  const sleeps = [];
  let geminiAttempts = 0;

  const review = await _test.runListingReviewPipeline({
    bucket: {},
    randomImpl: () => 0,
    sleepImpl: async (ms) => sleeps.push(ms),
    submission: validSubmission(),
    openAiReviewImpl: async () => ({
      decision: "approve",
      severity: "low",
      categories: [],
      reasons: [],
      providerResults: { openaiModeration: { flaggedCategories: [] } },
    }),
    geminiReviewImpl: async () => {
      geminiAttempts += 1;
      if (geminiAttempts < 3) {
        const error = new Error("Gemini quota exceeded");
        error.status = 429;
        throw error;
      }
      return {
        decision: "approve",
        severity: "low",
        categories: [],
        reasons: [],
      };
    },
  });

  assert.equal(review.decision, "approve");
  assert.equal(geminiAttempts, 3);
  assert.deepEqual(sleeps, [250, 500]);
  assert.deepEqual(review.providerResults.openaiModeration.flaggedCategories, []);
});

test("runListingReviewPipeline sends exhausted transient Gemini failures to manual review", async () => {
  let geminiAttempts = 0;

  const review = await _test.runListingReviewPipeline({
    bucket: {},
    geminiMaxAttempts: 2,
    randomImpl: () => 0,
    sleepImpl: async () => {},
    submission: validSubmission(),
    openAiReviewImpl: async () => ({
      decision: "approve",
      severity: "low",
      categories: [],
      reasons: [],
      providerResults: { openaiModeration: { flaggedCategories: [] } },
    }),
    geminiReviewImpl: async () => {
      geminiAttempts += 1;
      const error = new Error("Gemini service unavailable");
      error.code = "UNAVAILABLE";
      throw error;
    },
  });

  assert.equal(review.decision, "manual_review");
  assert.deepEqual(review.categories, ["provider_business_review_unavailable"]);
  assert.match(review.reasons[0], /Gemini listing review was temporarily unavailable/i);
  assert.equal(review.providerResults.geminiTextReview.error.code, "UNAVAILABLE");
  assert.equal(review.providerResults.geminiTextReview.error.isTransient, true);
  assert.deepEqual(review.providerResults.openaiModeration.flaggedCategories, []);
  assert.equal(geminiAttempts, 2);
});

test("runListingReviewPipeline surfaces non-transient Gemini errors", async () => {
  let geminiAttempts = 0;

  await assert.rejects(
    () =>
      _test.runListingReviewPipeline({
        bucket: {},
        submission: validSubmission(),
        openAiReviewImpl: async () => ({
          decision: "approve",
          severity: "low",
          categories: [],
          reasons: [],
          providerResults: { openaiModeration: { flaggedCategories: [] } },
        }),
        geminiReviewImpl: async () => {
          geminiAttempts += 1;
          throw new Error("Listing moderation did not return structured output");
        },
      }),
    /structured output/,
  );

  assert.equal(geminiAttempts, 1);
});

test("isTransientGeminiReviewError recognizes common provider failures", () => {
  assert.equal(_test.isTransientGeminiReviewError(Object.assign(new Error("quota exceeded"), { status: 429 })), true);
  assert.equal(_test.isTransientGeminiReviewError(Object.assign(new Error("unavailable"), { code: "UNAVAILABLE" })), true);
  assert.equal(_test.isTransientGeminiReviewError(new Error("Listing moderation did not return structured output")), false);
});
