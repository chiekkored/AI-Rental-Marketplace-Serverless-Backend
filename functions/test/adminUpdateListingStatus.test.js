const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _test: {
    buildAuditNotes,
    buildListingArchivedNotification,
    buildListingSnapshot,
    buildListingStatusNotification,
    normalizeUpdateListingStatusInput,
  },
} = require("../calls/adminUpdateListingStatus");

test("normalizeUpdateListingStatusInput accepts allowed status updates", () => {
  assert.deepEqual(
    normalizeUpdateListingStatusInput({
      assetId: " asset-1 ",
      status: " Available ",
    }),
    {
      assetId: "asset-1",
      reason: "",
      status: "Available",
    },
  );
});

test("normalizeUpdateListingStatusInput requires archive reason", () => {
  assert.throws(
    () =>
      normalizeUpdateListingStatusInput({
        assetId: "asset-1",
        status: "Archived",
      }),
    /Archive reason is required/,
  );

  const input = normalizeUpdateListingStatusInput({
    assetId: "asset-1",
    reason: ` ${"x".repeat(2100)} `,
    status: "Archived",
  });
  assert.equal(input.reason.length, 2000);
});

test("normalizeUpdateListingStatusInput rejects unsupported statuses", () => {
  assert.throws(
    () =>
      normalizeUpdateListingStatusInput({
        assetId: "asset-1",
        status: "Deleted",
      }),
    /Invalid listing status/,
  );
});

test("buildListingStatusNotification opens public listing target", () => {
  const notification = buildListingStatusNotification({
    assetId: "asset-1",
    listing: {
      images: ["https://example.com/listing.jpg"],
      title: "Camera",
    },
    ownerId: "owner-1",
    status: "Hidden",
  });

  assert.equal(notification.uid, "owner-1");
  assert.equal(notification.title, "Listing status updated");
  assert.equal(notification.body, "Your listing status was updated to Hidden.");
  assert.equal(notification.imageUrl, "https://example.com/listing.jpg");
  assert.deepEqual(notification.data, {
    type: "listing_moderation",
    target: "asset",
    assetId: "asset-1",
    status: "Hidden",
  });
});

test("buildListingArchivedNotification opens moderation notice target", () => {
  const notification = buildListingArchivedNotification({
    assetId: "asset-1",
    eventId: "event-1",
    listing: {
      showcase: ["https://example.com/showcase.jpg"],
      title: "Camera",
    },
    ownerId: "owner-1",
  });

  assert.equal(notification.uid, "owner-1");
  assert.equal(notification.title, "Listing archived");
  assert.equal(
    notification.body,
    "Your listing was archived by Lend Support. Open Lend to review the reason.",
  );
  assert.equal(notification.imageUrl, "https://example.com/showcase.jpg");
  assert.deepEqual(notification.data, {
    type: "listing_moderation",
    target: "deletedListing",
    action: "archived",
    assetId: "asset-1",
    eventId: "event-1",
  });
});

test("buildListingSnapshot preserves status and card fields", () => {
  const snapshot = buildListingSnapshot({
    assetId: "asset-1",
    listing: {
      ownerId: "owner-1",
      title: "Camera",
      categoryName: "Electronics",
      rates: { daily: 500 },
      status: "Archived",
    },
  });

  assert.equal(snapshot.id, "asset-1");
  assert.equal(snapshot.ownerId, "owner-1");
  assert.equal(snapshot.title, "Camera");
  assert.equal(snapshot.categoryName, "Electronics");
  assert.equal(snapshot.status, "Archived");
  assert.equal(snapshot.isDeleted, false);
});

test("buildAuditNotes includes reason only when provided", () => {
  assert.equal(
    buildAuditNotes({
      previousStatus: "Available",
      reason: "",
      status: "Hidden",
    }),
    "Status: Available -> Hidden",
  );
  assert.equal(
    buildAuditNotes({
      previousStatus: "Available",
      reason: "Unsafe item",
      status: "Archived",
    }),
    "Status: Available -> Archived\nReason: Unsafe item",
  );
});
