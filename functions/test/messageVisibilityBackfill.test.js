const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _test: { resolveVisibleTo, unique },
} = require("../scripts/backfillMessageVisibility");

test("resolveVisibleTo targets rating prompts to renter only", () => {
  assert.deepEqual(
    resolveVisibleTo({
      message: { type: "rating" },
      context: {
        renterId: "renter-1",
        participantIds: ["renter-1", "owner-1"],
      },
    }),
    ["renter-1"],
  );
});

test("resolveVisibleTo targets normal messages to chat participants", () => {
  assert.deepEqual(
    resolveVisibleTo({
      message: { type: "system" },
      context: {
        renterId: "renter-1",
        participantIds: ["renter-1", "owner-1"],
      },
    }),
    ["renter-1", "owner-1"],
  );
});

test("unique removes empty and duplicate recipients", () => {
  assert.deepEqual(unique(["renter-1", null, "owner-1", "renter-1", ""]), ["renter-1", "owner-1"]);
});
