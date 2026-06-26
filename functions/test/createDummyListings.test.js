const assert = require("node:assert/strict");
const test = require("node:test");

const { _test } = require("../calls/createDummyListings.js");

test("dummy listing owner id requires authentication", () => {
  assert.throws(
    () => _test.requireAuthenticatedDummyListingOwnerId({ auth: null }),
    /Sign in before creating dummy listings/,
  );
});

test("dummy listing owner id uses authenticated uid without admin claim", () => {
  assert.equal(
    _test.requireAuthenticatedDummyListingOwnerId({
      auth: {
        uid: "debug-user",
        token: {},
      },
    }),
    "debug-user",
  );
});

test("dummy listing owner id ignores supplied ownerId", () => {
  assert.equal(
    _test.requireAuthenticatedDummyListingOwnerId({
      auth: {
        uid: "debug-user",
        token: {},
      },
      data: {
        ownerId: "other-user",
      },
    }),
    "debug-user",
  );
});

test("dummy listing seed creates twenty realistic listings with remote photos", () => {
  const submissions = _test.buildDummyListingSubmissions({
    ownerId: "owner-1",
    categoriesById: fakeCategoriesById(),
    createAssetId: (() => {
      let index = 0;
      return () => `asset-${++index}`;
    })(),
  });

  assert.equal(submissions.length, 20);
  assert.equal(new Set(submissions.map((submission) => submission.title)).size, 20);
  assert.ok(submissions.every((submission) => !/\d/.test(submission.title)));
  assert.ok(submissions.every((submission) => submission.images.length >= 2));
  assert.ok(submissions.every((submission) => submission.blocksEndDate === false));
  assert.ok(
    submissions.every(
      (submission) =>
        submission.securityDeposit.enabled === true &&
        Number.isInteger(submission.securityDeposit.amount) &&
        submission.securityDeposit.amount > 0,
    ),
  );
  assert.ok(
    submissions.every((submission) =>
      submission.images.every((imageUrl) => imageUrl.startsWith("https://")),
    ),
  );
  assert.ok(submissions.every((submission) => submission.showcase[0] === submission.images[0]));
});

test("dummy listing seed includes stay, space, and vehicle listing schemas", () => {
  const submissions = _test.buildDummyListingSubmissions({
    ownerId: "owner-1",
    categoriesById: fakeCategoriesById(),
    createAssetId: () => "asset-id",
  });
  const schemas = new Set(submissions.map((submission) => submission.detailSchemaKey));

  assert.ok(schemas.has("stay"));
  assert.ok(schemas.has("space"));
  assert.ok(schemas.has("vehicle"));
});

test("dummy listing seed uses active web seed categories and amenities", () => {
  const requiredCategoryIds = _test.requiredCategoryIds();
  const submissions = _test.buildDummyListingSubmissions({
    ownerId: "owner-1",
    categoriesById: fakeCategoriesById(),
    createAssetId: () => "asset-id",
  });

  assert.ok(!requiredCategoryIds.includes("projectors"));
  assert.ok(requiredCategoryIds.includes("vehicles"));
  assert.ok(requiredCategoryIds.includes("stay-spaces"));
  assert.ok(requiredCategoryIds.includes("photo-booth-equipment"));

  const allowedAmenities = new Set([
    "wifi",
    "air-conditioning",
    "hot-water",
    "tv",
    "kitchen",
    "refrigerator",
    "private-bathroom",
    "bidet",
    "towels",
    "bed-sheets",
    "car-parking",
    "elevator",
    "self-check-in",
    "fire-extinguisher",
    "beach-access",
    "sea-view",
    "balcony",
    "power-outlets",
    "tables",
    "chairs",
    "projector",
    "restroom",
    "dressing-room",
    "staff-assistance",
    "cctv",
    "security-guard",
    "storage-area",
    "loading-area",
    "garden",
    "bbq-grill",
    "first-aid-kit",
  ]);

  const stayAndSpaceListings = submissions.filter((submission) =>
    ["stay", "space"].includes(submission.detailSchemaKey),
  );
  const amenities = stayAndSpaceListings.flatMap((submission) => submission.details.amenities || []);

  assert.ok(amenities.length > 0);
  assert.ok(amenities.every((amenity) => allowedAmenities.has(amenity)));
});

test("dummy listing seed writes geohashes for nearby listing queries", () => {
  assert.equal(_test.geohashFor(10.3317, 123.9056), "wcb4g8c69");

  const submissions = _test.buildDummyListingSubmissions({
    ownerId: "owner-1",
    categoriesById: fakeCategoriesById(),
    createAssetId: () => "asset-id",
  });

  assert.ok(
    submissions.every(
      (submission) =>
        typeof submission.location.geohash === "string" &&
        submission.location.geohash.length === 9,
    ),
  );
});

function fakeCategoriesById() {
  return Object.fromEntries(
    [
      category("vehicles", "Vehicles", "vehicle"),
      category("cars", "Cars", "vehicle"),
      category("motorcycles", "Motorcycles", "vehicle"),
      category("vans", "Vans", "vehicle"),
      category("trucks", "Trucks", "vehicle"),
      category("stay-spaces", "Stay & Spaces", "generic_asset"),
      category("stays", "Stays", "stay"),
      category("spaces", "Spaces", "space"),
      category("parking-spaces", "Parking Spaces", "space"),
      category("storage-spaces", "Storage Spaces", "space"),
      category("event-venues", "Event Venues", "space"),
      category("electronics", "Electronics", "electronics"),
      category("cameras", "Cameras", "electronics"),
      category("outdoor-gears", "Outdoor Gears", "generic_asset"),
      category("camping-gear", "Camping Gear", "generic_asset"),
      category("bikes-scooters", "Bikes & Scooters", "generic_asset"),
      category("tools-equipment", "Tools & Equipment", "tool"),
      category("power-tools", "Power Tools", "tool"),
      category("fashion", "Fashion", "clothing"),
      category("clothing", "Clothing", "clothing"),
      category("party-events", "Party & Events", "party_event"),
      category("tables-chairs", "Tables & Chairs", "party_event"),
      category("sound-lighting", "Sound & Lighting", "party_event"),
      category("photo-booth-equipment", "Photo Booth Equipment", "party_event"),
      category("others", "Others", "generic_asset"),
      category("baby-kids", "Baby & Kids", "generic_asset"),
    ].map((item) => [item.id, item]),
  );
}

function category(id, name, detailSchemaKey) {
  return {
    id,
    name,
    isActive: true,
    listingKind: detailSchemaKey,
    detailSchemaKey,
  };
}
