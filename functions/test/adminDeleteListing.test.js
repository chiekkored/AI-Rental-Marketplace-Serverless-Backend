const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _test: {
    buildDeletedListingSnapshot,
    buildListingDeletedNotification,
    normalizeDeleteListingInput,
  },
} = require("../calls/adminDeleteListing");

test("normalizeDeleteListingInput trims and caps deletion reason", () => {
  const input = normalizeDeleteListingInput({
    assetId: " asset-1 ",
    reason: ` ${"x".repeat(2100)} `,
  });

  assert.equal(input.assetId, "asset-1");
  assert.equal(input.reason.length, 2000);
});

test("buildDeletedListingSnapshot preserves mobile listing card fields", () => {
  const snapshot = buildDeletedListingSnapshot({
    assetId: "asset-1",
    listing: {
      ownerId: "owner-1",
      title: " Camera ",
      description: "Mirrorless camera",
      categoryId: "category-1",
      categoryName: "Electronics",
      rates: { daily: 500, currency: "PHP" },
      images: ["https://example.com/camera.jpg"],
      showcase: ["https://example.com/showcase.jpg"],
      isDeleted: false,
    },
  });

  assert.equal(snapshot.id, "asset-1");
  assert.equal(snapshot.ownerId, "owner-1");
  assert.equal(snapshot.title, "Camera");
  assert.equal(snapshot.description, "Mirrorless camera");
  assert.equal(snapshot.categoryName, "Electronics");
  assert.deepEqual(snapshot.rates, { daily: 500, currency: "PHP" });
  assert.equal(snapshot.isDeleted, true);
});

test("buildListingDeletedNotification targets deleted listing detail page", () => {
  const notification = buildListingDeletedNotification({
    assetId: "asset-1",
    eventId: "event-1",
    listing: {
      title: "Camera",
      images: ["https://example.com/camera.jpg"],
    },
    ownerId: "owner-1",
  });

  assert.equal(notification.uid, "owner-1");
  assert.equal(notification.title, "Listing deleted");
  assert.equal(
    notification.body,
    "Your listing was deleted due to violation of Lend terms and policies.",
  );
  assert.equal(notification.imageUrl, "https://example.com/camera.jpg");
  assert.equal(notification.persist, true);
  assert.equal(notification.push, true);
  assert.deepEqual(notification.data, {
    type: "listing_moderation",
    target: "deletedListing",
    action: "deleted",
    assetId: "asset-1",
    eventId: "event-1",
  });
});
