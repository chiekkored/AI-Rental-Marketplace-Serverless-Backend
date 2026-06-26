const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _test: {
    DEACTIVATION_REQUEST_STATUS,
    FUTURE_BLOCKING_BOOKING_STATUSES,
    buildDeactivationRequestData,
    buildDeletionEligibilityResult,
    filterFutureBlockingBookings,
    normalizeEvidenceUrls,
  },
} = require("../calls/listingDeactivation");

test("future blocking bookings include pending, confirmed, and cancellation requested bookings ending today or later", () => {
  const now = new Date(Date.UTC(2026, 5, 2, 10));
  const bookings = filterFutureBlockingBookings(
    [
      { id: "pending", status: "Pending", endDate: new Date(Date.UTC(2026, 5, 2)) },
      { id: "confirmed", status: "Confirmed", endDate: new Date(Date.UTC(2026, 5, 3)) },
      { id: "cancel-requested", status: "Cancellation Requested", endDate: new Date(Date.UTC(2026, 5, 3)) },
      { id: "past", status: "Confirmed", endDate: new Date(Date.UTC(2026, 5, 1)) },
      { id: "handed-over", status: "HandedOver", endDate: new Date(Date.UTC(2026, 5, 3)) },
    ],
    now,
  );

  assert.deepEqual(bookings.map((booking) => booking.id), ["pending", "confirmed", "cancel-requested"]);
  assert.deepEqual(FUTURE_BLOCKING_BOOKING_STATUSES, ["Pending", "Confirmed", "Cancellation Requested"]);
});

test("deletion eligibility exposes booking summaries", () => {
  const result = buildDeletionEligibilityResult([
    {
      id: "booking-1",
      renter: { uid: "renter-1", firstName: "Ana", lastName: "Cruz" },
      status: "Confirmed",
      totalPrice: 1200,
    },
  ]);

  assert.equal(result.canDelete, false);
  assert.equal(result.blockingBookingCount, 1);
  assert.equal(result.blockingBookings[0].renterName, "Ana Cruz");
});

test("deactivation request payload stores listing snapshot and evidence", () => {
  const now = new Date("2026-06-02T00:00:00.000Z");
  const payload = buildDeactivationRequestData({
    assetId: "asset-1",
    blockingBookings: [{ id: "booking-1", status: "Confirmed", totalPrice: 100 }],
    evidenceUrls: ["users/owner/listingDeactivationRequests/request-1/evidence/photo.jpg"],
    listing: {
      categoryId: "cameras", categoryName: "Cameras",
      images: ["image.jpg"],
      ownerId: "owner",
      status: "Available",
      title: "Camera",
    },
    notes: "Lens mount is broken.",
    now,
    ownerId: "owner",
    reason: "Verified damage",
    requestId: "request-1",
  });

  assert.equal(payload.status, DEACTIVATION_REQUEST_STATUS.pending);
  assert.equal(payload.listingSnapshot.title, "Camera");
  assert.equal(payload.bookingSummaries.length, 1);
  assert.deepEqual(payload.evidenceUrls, ["users/owner/listingDeactivationRequests/request-1/evidence/photo.jpg"]);
});

test("deactivation evidence URLs must belong to the request or be https URLs", () => {
  assert.deepEqual(
    normalizeEvidenceUrls(
      [
        "users/owner/listingDeactivationRequests/request-1/evidence/photo.jpg",
        "https://cdn.example.com/photo.jpg",
      ],
      "owner",
      "request-1",
    ),
    [
      "users/owner/listingDeactivationRequests/request-1/evidence/photo.jpg",
      "https://cdn.example.com/photo.jpg",
    ],
  );

  assert.throws(
    () => normalizeEvidenceUrls(["users/other/listingDeactivationRequests/request-1/evidence/photo.jpg"], "owner", "request-1"),
    /Evidence photos must belong/,
  );
});
