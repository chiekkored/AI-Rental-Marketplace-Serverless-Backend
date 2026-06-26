const OPENAI_MODERATION_MODEL = process.env.OPENAI_MODERATION_MODEL || "omni-moderation-latest";
const OPENAI_MODERATION_URL = "https://api.openai.com/v1/moderations";
const DEFAULT_OPENAI_MODERATION_MAX_ATTEMPTS = 3;
const OPENAI_MODERATION_BASE_RETRY_MS = 250;
const OPENAI_MODERATION_MAX_RETRY_MS = 2000;
const TRANSIENT_OPENAI_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

const OPENAI_CATEGORY_TO_REVIEW_CATEGORY = {
  harassment: "hate_harassment_or_threat",
  "harassment/threatening": "hate_harassment_or_threat",
  hate: "hate_harassment_or_threat",
  "hate/threatening": "hate_harassment_or_threat",
  illicit: "illegal_item",
  "illicit/violent": "weapon_or_dangerous_item",
  "self-harm": "self_harm_content",
  "self-harm/intent": "self_harm_content",
  "self-harm/instructions": "self_harm_content",
  sexual: "adult_or_sexual_item",
  "sexual/minors": "adult_or_sexual_item",
  violence: "violent_or_graphic_content",
  "violence/graphic": "violent_or_graphic_content",
};

class OpenAiModerationError extends Error {
  constructor({ body, isTransient, message, retryAfterMs = null, status }) {
    super(message);
    this.name = "OpenAiModerationError";
    this.body = body;
    this.isTransient = isTransient === true;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

async function reviewListingOpenAiModeration({
  bucket,
  buildImageReviewUrls,
  fetchImpl = globalThis.fetch,
  maxAttempts = DEFAULT_OPENAI_MODERATION_MAX_ATTEMPTS,
  randomImpl = Math.random,
  sleepImpl = sleep,
  submission,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("OpenAI moderation requires fetch support");
  }

  const imagePaths = [...(submission.images || []), ...(submission.showcase || [])];
  const imageReviewUrls = await buildImageReviewUrls({ bucket, paths: imagePaths });
  const input = [
    {
      type: "text",
      text: buildOpenAiModerationText(submission),
    },
    ...imageReviewUrls.map((image) => ({
      type: "image_url",
      image_url: { url: image.url },
    })),
  ];

  let lastError = null;
  const attempts = Math.max(1, Number(maxAttempts) || DEFAULT_OPENAI_MODERATION_MAX_ATTEMPTS);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchImpl(OPENAI_MODERATION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODERATION_MODEL,
        input,
      }),
    });

    if (response.ok) {
      const payload = await response.json();
      return buildOpenAiModerationReview(payload);
    }

    const error = await buildOpenAiModerationError(response);
    if (!error.isTransient || attempt >= attempts) {
      throw error;
    }

    lastError = error;
    await sleepImpl(resolveRetryDelayMs({ attempt, error, randomImpl }));
  }

  throw lastError || new Error("OpenAI moderation failed");
}

function buildOpenAiModerationText(submission) {
  return [
    "Lend peer-to-peer rental listing moderation input.",
    `Title: ${submission.title || ""}`,
    `Category: ${submission.categoryName || ""}`,
    `Subcategory: ${submission.subcategoryName || ""}`,
    `Listing kind: ${submission.listingKind || ""}`,
    `Detail schema: ${submission.detailSchemaKey || ""}`,
    `Details: ${JSON.stringify(submission.details || {})}`,
    `Description: ${submission.description || ""}`,
    `Inclusions: ${(submission.inclusions || []).join(", ")}`,
    `Owner instructions: ${submission.ownerInstructions || ""}`,
    `Daily rate: ${submission.rates?.daily || ""} ${submission.rates?.currency || ""}`.trim(),
  ].join("\n");
}

function buildOpenAiModerationReview(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const flaggedCategories = new Set();
  const categoryScores = {};
  const appliedInputTypes = {};

  for (const result of results) {
    for (const [category, flagged] of Object.entries(result?.categories || {})) {
      if (flagged === true) flaggedCategories.add(category);
    }
    for (const [category, score] of Object.entries(result?.category_scores || {})) {
      categoryScores[category] = score;
    }
    for (const [category, inputTypes] of Object.entries(result?.category_applied_input_types || {})) {
      appliedInputTypes[category] = inputTypes;
    }
  }

  const reviewCategories = [...new Set([...flaggedCategories].map(toReviewCategory).filter(Boolean))];
  if (!reviewCategories.length) {
    return {
      decision: "approve",
      severity: "low",
      categories: [],
      reasons: [],
      providerResults: {
        openaiModeration: summarizeOpenAiModeration(payload, categoryScores, appliedInputTypes, []),
      },
    };
  }

  return {
    decision: "reject",
    severity: flaggedCategories.has("sexual/minors") || flaggedCategories.has("self-harm/instructions") ? "high" : "medium",
    categories: reviewCategories,
    reasons: [`OpenAI moderation flagged: ${[...flaggedCategories].join(", ")}.`],
    providerResults: {
      openaiModeration: summarizeOpenAiModeration(payload, categoryScores, appliedInputTypes, [...flaggedCategories]),
    },
  };
}

function summarizeOpenAiModeration(payload, categoryScores, appliedInputTypes, flaggedCategories) {
  return {
    id: payload?.id || null,
    model: payload?.model || OPENAI_MODERATION_MODEL,
    flaggedCategories,
    categoryScores,
    categoryAppliedInputTypes: appliedInputTypes,
  };
}

function toReviewCategory(category) {
  return OPENAI_CATEGORY_TO_REVIEW_CATEGORY[category] || null;
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch (error) {
    return "";
  }
}

async function buildOpenAiModerationError(response) {
  const errorText = await safeReadText(response);
  const status = Number(response?.status || 0);
  const retryAfterMs = parseRetryAfterMs(getHeader(response, "retry-after"));
  const body = sanitizeOpenAiErrorBody(errorText);
  return new OpenAiModerationError({
    body,
    isTransient: TRANSIENT_OPENAI_STATUS_CODES.has(status),
    message: `OpenAI moderation failed with HTTP ${status}: ${body || response.statusText || "Unknown error"}`,
    retryAfterMs,
    status,
  });
}

function resolveRetryDelayMs({ attempt, error, randomImpl = Math.random }) {
  if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0) {
    return Math.min(error.retryAfterMs, OPENAI_MODERATION_MAX_RETRY_MS);
  }
  const jitter = Math.floor((typeof randomImpl === "function" ? randomImpl() : Math.random()) * 100);
  const exponentialDelay = OPENAI_MODERATION_BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponentialDelay + jitter, OPENAI_MODERATION_MAX_RETRY_MS);
}

function parseRetryAfterMs(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(text);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}

function sanitizeOpenAiErrorBody(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 1000);
}

function getHeader(response, name) {
  if (typeof response?.headers?.get === "function") return response.headers.get(name);
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  OPENAI_MODERATION_MODEL,
  OpenAiModerationError,
  buildOpenAiModerationReview,
  buildOpenAiModerationText,
  isTransientOpenAiModerationError,
  reviewListingOpenAiModeration,
  _test: {
    buildOpenAiModerationError,
    parseRetryAfterMs,
    resolveRetryDelayMs,
    toReviewCategory,
  },
};

function isTransientOpenAiModerationError(error) {
  return error instanceof OpenAiModerationError && error.isTransient === true;
}
