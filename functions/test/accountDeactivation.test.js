const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _test: {
    buildListingDeactivationUpdate,
    buildListingReactivationUpdate,
  },
} = require("../calls/account/deactivation");

test("listing deactivation stores prior recommendation suppression", () => {
  const now = new Date("2026-06-21T00:00:00.000Z");

  assert.deepEqual(
    buildListingDeactivationUpdate({
      status: "Available",
      suppressFromRecommendations: true,
    }, now),
    {
      status: "Hidden",
      suppressFromRecommendations: true,
      accountDeactivation: {
        active: true,
        deactivatedAt: now,
        previousStatus: "Available",
        previousSuppressFromRecommendations: true,
      },
      updatedAt: now,
    },
  );

  assert.equal(
    buildListingDeactivationUpdate({
      status: "Available",
      suppressFromRecommendations: false,
    }, now).accountDeactivation.previousSuppressFromRecommendations,
    false,
  );
});

test("listing reactivation restores prior recommendation suppression exactly", () => {
  const now = new Date("2026-06-21T00:00:00.000Z");

  assert.deepEqual(
    buildListingReactivationUpdate({
      status: "Hidden",
      suppressFromRecommendations: true,
      accountDeactivation: {
        active: true,
        previousStatus: "Available",
        previousSuppressFromRecommendations: true,
      },
    }, now),
    {
      status: "Available",
      suppressFromRecommendations: true,
      accountDeactivation: {
        active: false,
        previousStatus: "Available",
        previousSuppressFromRecommendations: true,
        reactivatedAt: now,
      },
      updatedAt: now,
    },
  );

  assert.equal(
    buildListingReactivationUpdate({
      status: "Hidden",
      suppressFromRecommendations: true,
      accountDeactivation: {
        active: true,
        previousStatus: "Available",
        previousSuppressFromRecommendations: false,
      },
    }, now).suppressFromRecommendations,
    false,
  );

  assert.equal(
    buildListingReactivationUpdate({
      status: "Hidden",
      suppressFromRecommendations: true,
      accountDeactivation: {
        active: true,
        previousStatus: "Hidden",
        previousSuppressFromRecommendations: false,
      },
    }, now).suppressFromRecommendations,
    false,
  );
});

test("listing reactivation keeps legacy suppression fallback for old deactivation records", () => {
  const now = new Date("2026-06-21T00:00:00.000Z");

  assert.equal(
    buildListingReactivationUpdate({
      status: "Hidden",
      suppressFromRecommendations: true,
      accountDeactivation: {
        active: true,
        previousStatus: "Available",
      },
    }, now).suppressFromRecommendations,
    false,
  );

  assert.equal(
    buildListingReactivationUpdate({
      status: "Hidden",
      suppressFromRecommendations: true,
      accountDeactivation: {
        active: true,
        previousStatus: "Hidden",
      },
    }, now).suppressFromRecommendations,
    true,
  );
});
