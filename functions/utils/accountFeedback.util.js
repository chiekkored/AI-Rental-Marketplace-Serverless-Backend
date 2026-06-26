const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("./error.util");

const deactivateReasons = new Set([
  "Taking a break",
  "Not renting or listing right now",
  "Too many notifications or messages",
  "Privacy or safety concern",
  "App issue or bug",
  "Other",
]);

const disableReasons = deactivateReasons;

const deleteReasons = new Set([
  "No longer need Lend",
  "Found another service",
  "Privacy or data concern",
  "Bad rental or listing experience",
  "App issue or bug",
  "Other",
]);

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phonePattern = /(?<!\d)\+?\d[\d\s().-]{6,}\d(?!\d)/g;

function validateAccountFeedback(feedback, expectedAction) {
  if (!feedback || typeof feedback !== "object" || Array.isArray(feedback)) {
    throwAndLogHttpsError("invalid-argument", "Missing account feedback.");
  }

  const action = asTrimmedString(feedback.action);
  const reason = asTrimmedString(feedback.reason);

  if (action !== expectedAction) {
    throwAndLogHttpsError("invalid-argument", "Invalid account feedback action.");
  }

  const allowedReasons = expectedAction === "delete" ? deleteReasons : deactivateReasons;
  if (!reason || !allowedReasons.has(reason)) {
    throwAndLogHttpsError("invalid-argument", "Invalid account feedback reason.");
  }

  const payload = { action, reason };
  const rawFeedback = asTrimmedString(feedback.feedback);

  if ((expectedAction === "disable" || expectedAction === "deactivate") && rawFeedback) {
    throwAndLogHttpsError("invalid-argument", "Deactivate feedback text is not supported.");
  }

  if (expectedAction === "delete" && rawFeedback) {
    if (rawFeedback.length > 1000) {
      throwAndLogHttpsError("invalid-argument", "Account feedback is too long.");
    }

    payload.feedback = redactPersonalInfo(rawFeedback);
  }

  return payload;
}

async function saveAccountFeedback(feedback, expectedAction, db = admin.firestore()) {
  const payload = validateAccountFeedback(feedback, expectedAction);
  const feedbackRef = db.collection("accountFeedback").doc();

  await feedbackRef.set({
    id: feedbackRef.id,
    ...payload,
    createdAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
  });

  return feedbackRef.id;
}

function redactPersonalInfo(value) {
  return value.replace(emailPattern, "[redacted]").replace(phonePattern, "[redacted]");
}

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  deleteReasons,
  deactivateReasons,
  disableReasons,
  redactPersonalInfo,
  saveAccountFeedback,
  validateAccountFeedback,
};
