const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _test: {
    buildDeletedListingUpdate,
    buildDeletedParticipantSnapshot,
    buildDeletedUserUpdate,
  },
} = require("../calls/account/deletion");

test("deleted user update anonymizes the profile and marks deletion metadata", () => {
  const now = new Date("2026-06-21T00:00:00.000Z");

  const update = buildDeletedUserUpdate(
    {
      uid: "owner",
      firstName: "Juan",
      lastName: "Dela Cruz",
      displayName: "Juan Rentals",
    },
    now,
    "owner",
  );

  assert.equal(update.status, "Deleted");
  assert.equal(update.firstName, null);
  assert.equal(update.displayName, null);
  assert.equal(update.deletion.active, true);
  assert.equal(update.deletion.requestedBy, "owner");
});

test("deleted listing update marks listing deleted and preserves moderation suppression", () => {
  const now = new Date("2026-06-21T00:00:00.000Z");

  const update = buildDeletedListingUpdate(
    {
      status: "Available",
      suppressFromRecommendations: true,
      accountDeactivation: {
        previousStatus: "Hidden",
        previousSuppressFromRecommendations: false,
      },
    },
    now,
  );

  assert.equal(update.isDeleted, true);
  assert.equal(update.status, "Archived");
  assert.equal(update.suppressFromRecommendations, true);
  assert.equal(update.accountDeletion.previousStatus, "Hidden");
  assert.equal(update.accountDeletion.previousSuppressFromRecommendations, true);
});

test("deleted participant snapshot removes personal display data", () => {
  assert.deepEqual(buildDeletedParticipantSnapshot("owner"), {
    uid: "owner",
    firstName: null,
    lastName: null,
    displayName: null,
    photoUrl: null,
    verified: "None",
    status: "Deleted",
    isFoundingOwner: false,
    userMetadataVersion: 1,
  });
});
