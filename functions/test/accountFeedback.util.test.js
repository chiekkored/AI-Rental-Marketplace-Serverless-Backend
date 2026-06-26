const assert = require("node:assert/strict");
const test = require("node:test");

const {
  redactPersonalInfo,
  validateAccountFeedback,
} = require("../utils/accountFeedback.util");

test("validateAccountFeedback accepts valid deactivate feedback", () => {
  assert.deepEqual(
    validateAccountFeedback({
      action: "deactivate",
      reason: "Taking a break",
    }, "deactivate"),
    {
      action: "deactivate",
      reason: "Taking a break",
    },
  );
});

test("validateAccountFeedback accepts delete feedback and redacts personal details", () => {
  assert.deepEqual(
    validateAccountFeedback({
      action: "delete",
      reason: "No longer need Lend",
      feedback: "Reach me at user@example.com or +63 917 123 4567.",
    }, "delete"),
    {
      action: "delete",
      reason: "No longer need Lend",
      feedback: "Reach me at [redacted] or [redacted].",
    },
  );
});

test("validateAccountFeedback omits empty optional delete feedback", () => {
  assert.deepEqual(
    validateAccountFeedback({
      action: "delete",
      reason: "Other",
      feedback: "   ",
    }, "delete"),
    {
      action: "delete",
      reason: "Other",
    },
  );
});

test("validateAccountFeedback rejects invalid action, reason, and deactivate text", () => {
  assert.throws(
    () => validateAccountFeedback({ action: "delete", reason: "Other" }, "deactivate"),
    /Invalid account feedback action/,
  );
  assert.throws(
    () => validateAccountFeedback({ action: "delete", reason: "Unsupported" }, "delete"),
    /Invalid account feedback reason/,
  );
  assert.throws(
    () => validateAccountFeedback({
      action: "deactivate",
      reason: "Other",
      feedback: "Extra text",
    }, "deactivate"),
    /Deactivate feedback text is not supported/,
  );
});

test("redactPersonalInfo removes common email and phone patterns", () => {
  assert.equal(
    redactPersonalInfo("Email me@example.com or call 0917-123-4567"),
    "Email [redacted] or call [redacted]",
  );
});
