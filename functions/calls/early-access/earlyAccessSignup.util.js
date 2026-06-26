const crypto = require("node:crypto");
const { throwAndLogHttpsError } = require("../../utils/error.util");

const EARLY_ACCESS_COLLECTION = "earlyAccessSignups";
const EARLY_ACCESS_RATE_LIMIT_COLLECTION = "earlyAccessSignupRateLimits";
const EARLY_ACCESS_SOURCE = "early_access_web";
const EARLY_ACCESS_EMAIL_MAX_LENGTH = 254;
const EARLY_ACCESS_RATE_LIMIT_MAX_ATTEMPTS = 5;
const EARLY_ACCESS_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEarlyAccessEmail(value) {
  if (typeof value !== "string") {
    throwAndLogHttpsError("invalid-argument", "Enter a valid email address.");
  }

  const email = value.trim().toLowerCase();

  if (
    !email ||
    email.length > EARLY_ACCESS_EMAIL_MAX_LENGTH ||
    !EMAIL_PATTERN.test(email)
  ) {
    throwAndLogHttpsError("invalid-argument", "Enter a valid email address.");
  }

  return email;
}

function hashEarlyAccessValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function getRequestIp(rawRequest) {
  const forwardedFor = rawRequest?.headers?.["x-forwarded-for"];
  const forwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const firstForwardedIp = forwardedIp?.split(",")[0]?.trim();

  return firstForwardedIp || rawRequest?.ip || "unknown";
}

function toMillis(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value._seconds === "number") return value._seconds * 1000;
  return null;
}

function nextRateLimitState(currentState, nowMillis) {
  const windowStartedAtMillis = toMillis(currentState?.windowStartedAt);
  const windowExpired =
    !windowStartedAtMillis ||
    nowMillis - windowStartedAtMillis >= EARLY_ACCESS_RATE_LIMIT_WINDOW_MS;
  const attemptCount = windowExpired ? 0 : currentState?.attemptCount || 0;

  if (attemptCount >= EARLY_ACCESS_RATE_LIMIT_MAX_ATTEMPTS) {
    throwAndLogHttpsError(
      "resource-exhausted",
      "Too many early access requests. Try again later.",
    );
  }

  return {
    attemptCount: attemptCount + 1,
    resetWindow: windowExpired,
  };
}

module.exports = {
  EARLY_ACCESS_COLLECTION,
  EARLY_ACCESS_RATE_LIMIT_COLLECTION,
  EARLY_ACCESS_SOURCE,
  EARLY_ACCESS_RATE_LIMIT_MAX_ATTEMPTS,
  EARLY_ACCESS_RATE_LIMIT_WINDOW_MS,
  getRequestIp,
  hashEarlyAccessValue,
  nextRateLimitState,
  normalizeEarlyAccessEmail,
};
