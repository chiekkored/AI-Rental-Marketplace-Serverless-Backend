const assert = require("node:assert/strict");
const test = require("node:test");

const {
  candidateFeedId,
  feedId,
  hasCoordinates,
  mergeFeeds,
  normalizeCategoryHints,
  normalizeLocationInput,
} = require("../utils/feedAlgorithm.util");
const { rankPersonalizedRecommendations } = require("../utils/recommendedAlgorithm.util");
const { rankAndDedupe } = require("../utils/popularAlgorithm.util");
const recommendationFacade = require("../utils/recommendations.util");

test("normalizeLocationInput prefers locality and keeps coordinates", () => {
  const location = normalizeLocationInput({
    country: " Philippines ",
    locality: " Makati ",
    cityState: "Legacy",
    lat: "14.5547",
    lng: 121.0244,
    geohash: "wdw4f",
  });

  assert.equal(location.country, "Philippines");
  assert.equal(location.locality, "Makati");
  assert.equal(location.localityKey, "makati");
  assert.equal(location.lat, 14.5547);
  assert.equal(location.lng, 121.0244);
  assert.equal(location.geohash, "wdw4f");
});

test("normalizeLocationInput falls back to legacy cityState", () => {
  const location = normalizeLocationInput({
    country: "Philippines",
    cityState: "Metro Manila",
  });

  assert.equal(location.locality, "Metro Manila");
  assert.equal(location.localityKey, "metro-manila");
});

test("hasCoordinates requires finite latitude and longitude", () => {
  assert.equal(hasCoordinates({ lat: 14.5547, lng: 121.0244 }), true);
  assert.equal(hasCoordinates({ lat: 14.5547, lng: null }), false);
  assert.equal(hasCoordinates({ lat: Number.NaN, lng: 121.0244 }), false);
});

test("normalizeCategoryHints keeps first five non-empty strings", () => {
  assert.deepEqual(
    normalizeCategoryHints([" Cameras ", "", "Tools", null, "Audio", "Sports", "Books", "Extra"]),
    [" Cameras ", "Tools", "Audio", "Sports", "Books"],
  );
});

test("feedId uses locality scope ids", () => {
  const location = normalizeLocationInput({
    country: "Philippines",
    locality: "Makati",
  });

  assert.equal(
    feedId({
      type: "recommended",
      scope: "locality",
      location,
      category: "cameras",
    }),
    "recommended_locality:philippines:makati:PHP:cameras",
  );
});

test("candidateFeedId is neutral and does not include user category hints", () => {
  const location = normalizeLocationInput({
    country: "Philippines",
    locality: "Makati",
  });

  assert.equal(
    candidateFeedId({
      scope: "locality",
      location,
    }),
    "candidate_locality:philippines:makati:PHP:all",
  );
});

test("rankPersonalizedRecommendations returns empty without user profile signal", () => {
  const assets = [
    asset({ id: "asset-1", categoryId: "cameras", categoryName: "Cameras", recommendationScore: 10 }),
  ];

  assert.deepEqual(
    rankPersonalizedRecommendations(assets, { categoryWeights: {} }),
    [],
  );
});

test("rankPersonalizedRecommendations ranks uniquely by user category affinity", () => {
  const assets = [
    asset({ id: "camera", categoryId: "cameras", categoryName: "Cameras", recommendationScore: 1 }),
    asset({ id: "tool", categoryId: "tools", categoryName: "Tools", recommendationScore: 20 }),
  ];

  const cameraUser = rankPersonalizedRecommendations(
    assets,
    { categoryWeights: { cameras: 3 } },
    { limit: 12, currentUserId: "user-1" },
  );
  const toolUser = rankPersonalizedRecommendations(
    assets,
    { categoryWeights: { tools: 3 } },
    { limit: 12, currentUserId: "user-1" },
  );

  assert.deepEqual(
    cameraUser.map((item) => item.id),
    ["camera"],
  );
  assert.deepEqual(
    toolUser.map((item) => item.id),
    ["tool"],
  );
});

test("rankPersonalizedRecommendations excludes current user's own assets", () => {
  const assets = [
    asset({ id: "mine", ownerId: "user-1", categoryId: "cameras", categoryName: "Cameras" }),
    asset({ id: "other", ownerId: "user-2", categoryId: "cameras", categoryName: "Cameras" }),
  ];

  const ranked = rankPersonalizedRecommendations(
    assets,
    { categoryWeights: { cameras: 3 } },
    { limit: 12, currentUserId: "user-1" },
  );

  assert.deepEqual(
    ranked.map((item) => item.id),
    ["other"],
  );
});

test("rankPersonalizedRecommendations excludes blocked owners", () => {
  const assets = [
    asset({ id: "blocked", ownerId: "user-2" }),
    asset({ id: "visible", ownerId: "user-3" }),
  ];

  const ranked = rankPersonalizedRecommendations(
    assets,
    { categoryWeights: { cameras: 3 } },
    { currentUserId: "user-1", excludedOwnerIds: new Set(["user-2"]) },
  );

  assert.deepEqual(ranked.map((item) => item.id), ["visible"]);
});

test("rankPersonalizedRecommendations excludes archived assets", () => {
  const assets = [
    asset({ id: "archived", status: "Archived", recommendationScore: 100 }),
    asset({ id: "available", status: "Available", recommendationScore: 10 }),
  ];

  const ranked = rankPersonalizedRecommendations(
    assets,
    { categoryWeights: { cameras: 3 } },
    { limit: 12, currentUserId: "user-1" },
  );

  assert.deepEqual(
    ranked.map((item) => item.id),
    ["available"],
  );
});

test("mergeFeeds keeps source order and removes duplicate asset ids", () => {
  const merged = mergeFeeds([
    [asset({ id: "nearby" }), asset({ id: "shared", title: "nearby copy" })],
    null,
    [asset({ id: "shared", title: "country copy" }), asset({ id: "country" })],
  ]);

  assert.deepEqual(
    merged.map((item) => item.id),
    ["nearby", "shared", "country"],
  );
  assert.equal(merged.find((item) => item.id === "shared").title, "nearby copy");
});

test("rankAndDedupe excludes current user's own assets from popular results", () => {
  const assets = [
    asset({ id: "mine", ownerId: "user-1", popularityScore: 100 }),
    asset({ id: "other", ownerId: "user-2", popularityScore: 10 }),
  ];

  const ranked = rankAndDedupe(assets, {
    currentUserId: "user-1",
    type: "popular",
  });

  assert.deepEqual(
    ranked.map((item) => item.id),
    ["other"],
  );
});

test("rankAndDedupe excludes archived assets from popular results", () => {
  const assets = [
    asset({ id: "archived", status: "Archived", popularityScore: 100 }),
    asset({ id: "available", status: "Available", popularityScore: 10 }),
  ];

  const ranked = rankAndDedupe(assets, {
    currentUserId: "user-1",
    type: "popular",
  });

  assert.deepEqual(
    ranked.map((item) => item.id),
    ["available"],
  );
});

test("rankAndDedupe excludes blocked owners from popular results", () => {
  const ranked = rankAndDedupe(
    [
      asset({ id: "blocked", ownerId: "user-2", popularityScore: 100 }),
      asset({ id: "visible", ownerId: "user-3", popularityScore: 10 }),
    ],
    {
      currentUserId: "user-1",
      excludedOwnerIds: new Set(["user-2"]),
      type: "popular",
    },
  );

  assert.deepEqual(ranked.map((item) => item.id), ["visible"]);
});

test("recommendations.util keeps backward-compatible algorithm exports", () => {
  assert.equal(recommendationFacade.normalizeLocationInput, normalizeLocationInput);
  assert.equal(recommendationFacade.rankPersonalizedRecommendations, rankPersonalizedRecommendations);
  assert.equal(recommendationFacade.rankAndDedupe, rankAndDedupe);
});

function asset(overrides = {}) {
  return {
    id: "asset",
    ownerId: "owner",
    categoryId: "cameras", categoryName: "Cameras",
    status: "Available",
    isDeleted: false,
    suppressFromRecommendations: false,
    recommendationScore: 0,
    qualityScore: 0,
    averageRating: null,
    reviewCount: null,
    ...overrides,
  };
}
