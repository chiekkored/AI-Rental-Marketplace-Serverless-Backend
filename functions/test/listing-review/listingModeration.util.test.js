const assert = require("node:assert/strict");
const test = require("node:test");
const functions = require("firebase-functions");

const listingModeration = require("../../listing-review/listingModeration.util");

const {
  buildImageReviewUrls,
  _test: {
    buildAssetData,
    buildSimpleAssetData,
    assertImageRefsAllowed,
    assertOwnerPayoutDestinationConfigured,
    buildOwnerComplianceRisk,
    buildOwnerComplianceRiskReasons,
    normalizeListingSubmission,
    buildInitialReviewSubmissionData,
    buildListingApprovedNotification,
    buildListingReviewNotification,
    hasApprovedBusinessRegistration,
    isHighValueListing,
    isOwnerComplianceActiveListing,
    isRegulatedListing,
    publicFirebaseDownloadUrl,
  },
} = listingModeration;

function fakePaymentDb(paymentDataByUid = {}) {
  return {
    collection(name) {
      assert.equal(name, "users");
      return {
        doc(uid) {
          return {
            collection(privateCollection) {
              assert.equal(privateCollection, "private");
              return {
                doc(privateDoc) {
                  assert.equal(privateDoc, "payment");
                  return {
                    async get() {
                      const data = paymentDataByUid[uid];
                      return {
                        exists: data != null,
                        data: () => data,
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

function fakeComplianceDb({ assets = [], bookingsByAssetId = {}, usersByUid = {} } = {}) {
  return {
    collection(name) {
      if (name === "users") {
        return {
          doc(uid) {
            return {
              async get() {
                const user = usersByUid[uid];
                return {
                  exists: user != null,
                  data: () => user,
                };
              },
              collection(collectionName) {
                assert.equal(collectionName, "assets");
                return {
                  async get() {
                    return {
                      forEach(callback) {
                        assets.forEach((asset) => {
                          callback({
                            id: asset.id,
                            data: () => ({ ...asset }),
                          });
                        });
                      },
                    };
                  },
                };
              },
              id: uid,
            };
          },
        };
      }

      if (name === "assets") {
        return {
          doc(assetId) {
            return {
              collection(collectionName) {
                assert.equal(collectionName, "bookings");
                return {
                  where(fieldPath, operator, since) {
                    assert.equal(fieldPath, "createdAt");
                    assert.equal(operator, ">=");
                    const sinceDate = since?.toDate ? since.toDate() : since;
                    return {
                      async get() {
                        const bookings = (bookingsByAssetId[assetId] || []).filter((booking) => {
                          const createdAt = booking.createdAt?.toDate
                            ? booking.createdAt.toDate()
                            : booking.createdAt;
                          return createdAt >= sinceDate;
                        });
                        return {
                          forEach(callback) {
                            bookings.forEach((booking, index) => {
                              callback({
                                id: `booking-${index}`,
                                data: () => ({ ...booking }),
                              });
                            });
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected collection ${name}`);
    },
  };
}

test("normalizeListingSubmission accepts owned draft images", () => {
  const submission = normalizeListingSubmission(
    {
      submissionType: "create",
      ownerId: "owner",
      listing: {
        title: "Camera Kit",
        description: "Mirrorless camera for rent.",
        categoryId: "cameras", categoryName: "Cameras",
        listingKind: "electronics",
        detailSchemaKey: "electronics",
        details: {
          brand: "Sony",
          chargerIncluded: true,
        },
        rates: { daily: 1200, currency: "PHP" },
        location: { lat: 14.5, lng: 121, geohash: "wdw", formattedAddress: "Makati" },
        images: ["users/owner/listingDrafts/draft-1/images/photo.jpg"],
        showcase: ["users/owner/listingDrafts/draft-1/images/showcase.webp"],
        inclusions: ["Battery", "camera bag"],
        securityDeposit: { enabled: true, amount: 5000 },
      },
    },
    "owner",
  );

  assert.equal(submission.ownerId, "owner");
  assert.equal(submission.title, "Camera Kit");
  assert.equal(submission.images.length, 1);
  assert.equal(submission.securityDeposit.amount, 5000);
  assert.equal(submission.listingKind, "electronics");
  assert.equal(submission.detailSchemaKey, "electronics");
  assert.deepEqual(submission.details, {
    brand: "Sony",
    chargerIncluded: true,
  });
});

test("normalizeListingSubmission preserves nested time window details", () => {
  const submission = normalizeListingSubmission(
    {
      submissionType: "create",
      ownerId: "owner",
      listing: {
        title: "Event Space",
        description: "Flexible event space with time windows.",
        categoryId: "spaces",
        categoryName: "Spaces",
        listingKind: "space",
        detailSchemaKey: "space",
        details: {
          capacity: 20,
          operatingHours: {
            enabled: false,
          },
          noiseRestrictions: {
            enabled: true,
            startTime: "22:00",
            endTime: "06:00",
          },
        },
        rates: { daily: 2500 },
        location: { lat: 14.5, lng: 121 },
        images: ["users/owner/listingDrafts/draft-1/images/photo.jpg"],
        showcase: [],
        inclusions: [],
      },
    },
    "owner",
  );

  assert.deepEqual(submission.details, {
    capacity: 20,
    operatingHours: {
      enabled: false,
    },
    noiseRestrictions: {
      enabled: true,
      startTime: "22:00",
      endTime: "06:00",
    },
  });
});

test("normalizeListingSubmission rejects owner mismatch and image ownership rejects non-draft paths", () => {
  assert.throws(
    () =>
      normalizeListingSubmission(
        {
          submissionType: "create",
          ownerId: "other",
          listing: {},
        },
        "owner",
      ),
    functions.https.HttpsError,
  );

  assert.throws(
    () => {
      const submission = normalizeListingSubmission(
        {
          submissionType: "create",
          ownerId: "owner",
          listing: {
            title: "Camera",
            categoryId: "cameras", categoryName: "Cameras",
            rates: { daily: 100 },
            location: { lat: 1, lng: 2 },
            images: ["owner/posts/images/photo.jpg"],
            showcase: [],
          },
        },
        "owner",
      );
      assertImageRefsAllowed({ uid: "owner", submission });
    },
    functions.https.HttpsError,
  );
});

test("buildAssetData and buildSimpleAssetData preserve public listing shape", () => {
  const now = new Date("2026-06-02T00:00:00.000Z");
  const asset = buildAssetData({
    submission: {
      ownerId: "owner",
      title: "Speaker",
      description: "Bluetooth speaker rental",
      categoryId: "electronics", categoryName: "Electronics",
      listingKind: "electronics",
      detailSchemaKey: "electronics",
      details: { brand: "JBL", chargerIncluded: true },
      rates: { daily: 300 },
      location: { lat: 14.5, lng: 121 },
      inclusions: [],
      ownerInstructions: null,
      blocksEndDate: false,
      status: "Available",
      securityDeposit: { enabled: false, amount: 0 },
    },
    listingId: "asset-1",
    owner: { firstName: "Owner", verified: "Full" },
    imageUrls: {
      images: ["https://firebasestorage.googleapis.com/v0/b/bucket/o/listings%2Fasset-1%2Fimages%2Fphoto.jpg"],
      showcase: [],
    },
    now,
  });
  const simple = buildSimpleAssetData(asset);

  assert.equal(asset.id, "asset-1");
  assert.equal(asset.owner.uid, "owner");
  assert.equal(asset.listingKind, "electronics");
  assert.equal(asset.detailSchemaKey, "electronics");
  assert.deepEqual(asset.details, { brand: "JBL", chargerIncluded: true });
  assert.equal(simple.pendingBookingCount, 0);
  assert.deepEqual(simple.images, asset.images);
  assert.deepEqual(simple.details, asset.details);
});

test("publicFirebaseDownloadUrl builds HTTPS Firebase Storage URL", () => {
  const url = publicFirebaseDownloadUrl("bucket.app", "listings/asset/images/photo.jpg", "token");
  assert.equal(
    url,
    "https://firebasestorage.googleapis.com/v0/b/bucket.app/o/listings%2Fasset%2Fimages%2Fphoto.jpg?alt=media&token=token",
  );
});

test("buildInitialReviewSubmissionData stores queued owner-owned review document", () => {
  const now = new Date("2026-06-02T00:00:00.000Z");
  const submission = {
    submissionType: "create",
    assetId: "asset-1",
    ownerId: "owner",
    title: "Camera",
  };

  const data = buildInitialReviewSubmissionData({
    submissionId: "submission-1",
    submission,
    uid: "owner",
    now,
  });

  assert.equal(data.id, "submission-1");
  assert.equal(data.ownerId, "owner");
  assert.equal(data.status, "Queued");
  assert.equal(data.aiReview, null);
  assert.deepEqual(data.listing, submission);
});

test("owner compliance helpers classify active, high-value, and regulated listings", () => {
  assert.equal(
    isOwnerComplianceActiveListing({
      isDeleted: false,
      status: "Hidden",
    }),
    true,
  );
  assert.equal(
    isOwnerComplianceActiveListing({
      isDeleted: true,
      status: "Available",
    }),
    false,
  );
  assert.equal(isHighValueListing({ rates: { daily: 5000 } }), true);
  assert.equal(
    isHighValueListing({
      rates: { daily: 1000 },
      securityDeposit: { enabled: true, amount: 20000 },
    }),
    true,
  );
  assert.equal(isRegulatedListing({ detailSchemaKey: "vehicle" }), true);
});

test("hasApprovedBusinessRegistration accepts only approved business profiles", () => {
  assert.equal(hasApprovedBusinessRegistration({ businessRegistration: { status: "Approved" } }), true);
  assert.equal(hasApprovedBusinessRegistration({ businessRegistration: { status: "Submitted" } }), false);
  assert.equal(hasApprovedBusinessRegistration({ businessRegistration: { status: "Rejected" } }), false);
  assert.equal(hasApprovedBusinessRegistration({}), false);
});

test("buildOwnerComplianceRisk stays below thresholds", async () => {
  const risk = await buildOwnerComplianceRisk({
    db: fakeComplianceDb({
      assets: [
        {
          id: "asset-1",
          isDeleted: false,
          status: "Available",
          detailSchemaKey: "electronics",
          rates: { daily: 1000 },
        },
      ],
      bookingsByAssetId: {
        "asset-1": [
          {
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
            priceBreakdown: { rentalSubtotal: 1000 },
            status: "Completed",
          },
        ],
      },
    }),
    uid: "owner",
    submission: {
      id: "asset-2",
      assetId: "asset-2",
      status: "Available",
      detailSchemaKey: "electronics",
      rates: { daily: 1200 },
      securityDeposit: { enabled: false, amount: 0 },
    },
    now: new Date("2026-06-09T00:00:00.000Z"),
  });

  assert.equal(risk.triggered, false);
  assert.equal(risk.metrics.activeListingCount, 2);
  assert.equal(risk.metrics.recentBookingCount30d, 1);
  assert.equal(risk.metrics.recentGrossRentalAmount30d, 1000);
});

test("buildOwnerComplianceRisk triggers each conservative threshold", () => {
  const reasons = buildOwnerComplianceRiskReasons({
    metrics: {
      highValueActiveListingCount: 5,
      recentBookingCount30d: 10,
      recentGrossRentalAmount30d: 100000,
      regulatedPortfolioCount: 3,
    },
    thresholds: {
      highValueActiveListingCount: 5,
      recentBookingCount30d: 10,
      recentGrossRentalAmount30d: 100000,
      regulatedPortfolioCount: 3,
    },
  });

  assert.equal(reasons.length, 4);
  assert.match(reasons[0], /high-value/);
  assert.match(reasons[1], /30 days/);
  assert.match(reasons[2], /PHP 100000/);
  assert.match(reasons[3], /fleet or multiple-property/);
});

test("buildOwnerComplianceRisk includes current submission and ignores cancelled bookings", async () => {
  const assets = Array.from({ length: 4 }, (_, index) => ({
    id: `asset-${index}`,
    isDeleted: false,
    status: index === 0 ? "Under Maintenance" : "Available",
    detailSchemaKey: "electronics",
    rates: { daily: 5000 },
    securityDeposit: { enabled: false, amount: 0 },
  }));
  const risk = await buildOwnerComplianceRisk({
    db: fakeComplianceDb({
      assets,
      bookingsByAssetId: {
        "asset-0": [
          {
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
            status: "Cancelled",
            totalPrice: 50000,
          },
        ],
      },
    }),
    uid: "owner",
    submission: {
      id: "asset-new",
      assetId: "asset-new",
      status: "Pending",
      detailSchemaKey: "electronics",
      rates: { daily: 5000 },
      securityDeposit: { enabled: false, amount: 0 },
    },
    now: new Date("2026-06-09T00:00:00.000Z"),
  });

  assert.equal(risk.triggered, true);
  assert.equal(risk.metrics.highValueActiveListingCount, 5);
  assert.equal(risk.metrics.recentBookingCount30d, 0);
  assert.equal(risk.metrics.recentGrossRentalAmount30d, 0);
});

test("buildOwnerComplianceRisk passes owner compliance for approved business registration", async () => {
  const assets = Array.from({ length: 5 }, (_, index) => ({
    id: `asset-${index}`,
    isDeleted: false,
    status: "Available",
    detailSchemaKey: "electronics",
    rates: { daily: 5000 },
    securityDeposit: { enabled: false, amount: 0 },
  }));

  const risk = await buildOwnerComplianceRisk({
    db: fakeComplianceDb({
      assets,
      usersByUid: {
        owner: {
          businessRegistration: { status: "Approved" },
        },
      },
    }),
    uid: "owner",
    submission: {
      id: "asset-new",
      assetId: "asset-new",
      status: "Pending",
      detailSchemaKey: "electronics",
      rates: { daily: 5000 },
      securityDeposit: { enabled: false, amount: 0 },
    },
    now: new Date("2026-06-09T00:00:00.000Z"),
  });

  assert.equal(risk.triggered, false);
  assert.equal(risk.complianceSatisfiedBy, "approved_business_registration");
  assert.deepEqual(risk.reasons, []);
  assert.equal(risk.metrics, null);
});

test("assertOwnerPayoutDestinationConfigured requires owner payout destination", async () => {
  await assertOwnerPayoutDestinationConfigured({
    db: fakePaymentDb({ owner: { payoutDestination: { bankId: "bank-1" } } }),
    uid: "owner",
  });

  await assert.rejects(
    () =>
      assertOwnerPayoutDestinationConfigured({
        db: fakePaymentDb({ owner: { depositReturnDestination: { bankId: "bank-2" } } }),
        uid: "owner",
      }),
    functions.https.HttpsError,
  );
});

test("buildListingReviewNotification targets rejected listing review result", () => {
  const notification = buildListingReviewNotification({
    submissionId: "submission-1",
    queueItem: {
      ownerId: "owner",
      listing: { title: "Camera", images: ["users/owner/listingDrafts/draft-1/images/photo.jpg"] },
      aiReview: {
        reasons: ["External payment instructions are not allowed."],
      },
    },
  });

  assert.equal(notification.uid, "owner");
  assert.equal(notification.title, "Listing rejected");
  assert.equal(notification.imageUrl, "users/owner/listingDrafts/draft-1/images/photo.jpg");
  assert.equal(notification.push, true);
  assert.equal(notification.persist, true);
  assert.deepEqual(notification.data, {
    type: "listing_review",
    target: "listingReviewResult",
    submissionId: "submission-1",
    decision: "reject",
  });
  assert.equal(notification.body, "External payment instructions are not allowed.");
});

test("buildListingApprovedNotification targets public asset", () => {
  const notification = buildListingApprovedNotification({
    assetId: "asset-1",
    queueItem: {
      ownerId: "owner",
      listing: { title: "Camera", images: ["https://cdn.example.com/camera.jpg"] },
    },
  });

  assert.equal(notification.uid, "owner");
  assert.equal(notification.title, "Listing approved");
  assert.equal(notification.body, "This listing is now publicly available");
  assert.equal(notification.imageUrl, "https://cdn.example.com/camera.jpg");
  assert.deepEqual(notification.data, {
    type: "listing_review",
    target: "asset",
    assetId: "asset-1",
    decision: "approve",
  });
});

test("buildImageReviewUrls returns data URLs without signing storage objects", async () => {
  let metadataCalls = 0;
  let downloadCalls = 0;
  const bucket = {
    file(path) {
      assert.equal(path, "users/owner/listingDrafts/draft-1/images/photo.png");
      return {
        async getMetadata() {
          metadataCalls += 1;
          return [{ contentType: "image/png", size: "4" }];
        },
        async download() {
          downloadCalls += 1;
          return [Buffer.from("test")];
        },
        async getSignedUrl() {
          throw new Error("getSignedUrl should not be called");
        },
      };
    },
  };

  const result = await buildImageReviewUrls({
    bucket,
    paths: ["users/owner/listingDrafts/draft-1/images/photo.png"],
  });

  assert.equal(metadataCalls, 1);
  assert.equal(downloadCalls, 1);
  assert.deepEqual(result, [
    {
      path: "users/owner/listingDrafts/draft-1/images/photo.png",
      url: "data:image/png;base64,dGVzdA==",
      contentType: "image/png",
    },
  ]);
});

test("buildImageReviewUrls rejects oversized review images", async () => {
  const bucket = {
    file() {
      return {
        async getMetadata() {
          return [{ contentType: "image/jpeg", size: String(5 * 1024 * 1024 + 1) }];
        },
        async download() {
          throw new Error("download should not be called for oversized metadata");
        },
      };
    },
  };

  await assert.rejects(
    () =>
      buildImageReviewUrls({
        bucket,
        paths: ["users/owner/listingDrafts/draft-1/images/large.jpg"],
      }),
    functions.https.HttpsError,
  );
});
