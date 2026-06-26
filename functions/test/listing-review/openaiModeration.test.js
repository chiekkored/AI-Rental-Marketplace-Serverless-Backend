const assert = require("node:assert/strict");
const test = require("node:test");

const {
  OpenAiModerationError,
  buildOpenAiModerationReview,
  buildOpenAiModerationText,
  reviewListingOpenAiModeration,
  _test,
} = require("../../listing-review/openaiModeration");

test("OpenAI moderation review approves when no categories are flagged", () => {
  const review = buildOpenAiModerationReview({
    id: "modr-1",
    model: "omni-moderation-latest",
    results: [
      {
        categories: { sexual: false, violence: false },
        category_scores: { sexual: 0.01, violence: 0.02 },
      },
    ],
  });

  assert.equal(review.decision, "approve");
  assert.deepEqual(review.categories, []);
  assert.equal(review.providerResults.openaiModeration.id, "modr-1");
});

test("OpenAI moderation review rejects flagged safety categories", () => {
  const review = buildOpenAiModerationReview({
    id: "modr-2",
    model: "omni-moderation-latest",
    results: [
      {
        categories: { sexual: true, violence: true },
        category_scores: { sexual: 0.91, violence: 0.8 },
        category_applied_input_types: { sexual: ["image"], violence: ["text"] },
      },
    ],
  });

  assert.equal(review.decision, "reject");
  assert.deepEqual(review.categories.sort(), ["adult_or_sexual_item", "violent_or_graphic_content"].sort());
  assert.deepEqual(review.providerResults.openaiModeration.flaggedCategories.sort(), ["sexual", "violence"].sort());
});

test("OpenAI moderation text includes listing fields without image data", () => {
  const text = buildOpenAiModerationText({
    title: "Speaker",
    description: "Portable speaker for rent.",
    categoryName: "Electronics",
    details: { brand: "JBL" },
    inclusions: ["charger"],
    ownerInstructions: "Return charged.",
    rates: { daily: 500, currency: "PHP" },
  });

  assert.match(text, /Speaker/);
  assert.match(text, /Portable speaker/);
  assert.doesNotMatch(text, /data:image/);
});

test("OpenAI moderation 429 creates transient error with retry metadata", async () => {
  const error = await _test.buildOpenAiModerationError(
    fakeResponse({
      body: '{"error":{"message":"Too Many Requests"}}',
      headers: { "retry-after": "2" },
      status: 429,
    }),
  );

  assert.equal(error instanceof OpenAiModerationError, true);
  assert.equal(error.status, 429);
  assert.equal(error.isTransient, true);
  assert.equal(error.retryAfterMs, 2000);
  assert.match(error.body, /Too Many Requests/);
});

test("OpenAI moderation retries transient failures and succeeds", async () => {
  const restoreEnv = setOpenAiKeyForTest();
  const attempts = [];
  const sleeps = [];
  try {
    const review = await reviewListingOpenAiModeration({
      bucket: {},
      buildImageReviewUrls: async () => [],
      fetchImpl: async () => {
        attempts.push(true);
        if (attempts.length === 1) {
          return fakeResponse({ body: "rate limited", status: 429 });
        }
        return fakeResponse({
          json: {
            id: "modr-ok",
            model: "omni-moderation-latest",
            results: [{ categories: {}, category_scores: {} }],
          },
          ok: true,
          status: 200,
        });
      },
      randomImpl: () => 0,
      sleepImpl: async (ms) => sleeps.push(ms),
      submission: validSubmission(),
    });

    assert.equal(review.decision, "approve");
    assert.equal(attempts.length, 2);
    assert.deepEqual(sleeps, [250]);
  } finally {
    restoreEnv();
  }
});

test("OpenAI moderation stops retrying after max attempts", async () => {
  const restoreEnv = setOpenAiKeyForTest();
  try {
    await assert.rejects(
      () =>
        reviewListingOpenAiModeration({
          bucket: {},
          buildImageReviewUrls: async () => [],
          fetchImpl: async () => fakeResponse({ body: "rate limited", status: 429 }),
          maxAttempts: 2,
          randomImpl: () => 0,
          sleepImpl: async () => {},
          submission: validSubmission(),
        }),
      (error) => error instanceof OpenAiModerationError && error.status === 429 && error.isTransient === true,
    );
  } finally {
    restoreEnv();
  }
});

function validSubmission() {
  return {
    title: "Camera Kit",
    description: "Mirrorless camera for rent.",
    categoryName: "Cameras",
    details: {},
    inclusions: [],
    ownerInstructions: "",
    rates: { daily: 1200, currency: "PHP" },
    images: [],
    showcase: [],
  };
}

function fakeResponse({ body = "", headers = {}, json = {}, ok = false, status = 429, statusText = "" } = {}) {
  return {
    ok,
    status,
    statusText,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] || null;
      },
    },
    async json() {
      return json;
    },
    async text() {
      return body;
    },
  };
}

function setOpenAiKeyForTest() {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  return () => {
    if (previous === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previous;
    }
  };
}
