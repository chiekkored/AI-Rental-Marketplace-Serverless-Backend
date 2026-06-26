const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");
const { throwAndLogHttpsError } = require("../utils/error.util");
const { firstListingImageUrl, sendNotificationToUser } = require("../utils/notification.util");

const LISTING_REVIEW_STATUS = {
  queued: "Queued",
  processing: "Processing",
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  deleted: "Deleted",
};

const MAX_BANNER_IMAGES = 6;
const MAX_SHOWCASE_IMAGES = 12;
const MAX_TOTAL_IMAGES = MAX_BANNER_IMAGES + MAX_SHOWCASE_IMAGES;
const MAX_REVIEW_IMAGE_BYTES = 5 * 1024 * 1024;
const OWNER_COMPLIANCE_ACTIVE_STATUSES = ["Available", "Under Maintenance", "Hidden", "Approved", "Pending"];
const OWNER_COMPLIANCE_REGULATED_SCHEMA_KEYS = ["stay", "space", "vehicle"];
const OWNER_COMPLIANCE_THRESHOLDS = {
  highValueDailyRate: 5000,
  highValueSecurityDeposit: 20000,
  highValueActiveListingCount: 5,
  recentBookingCount30d: 10,
  recentGrossRentalAmount30d: 100000,
  regulatedPortfolioCount: 3,
};

const MODERATED_ASSET_FIELDS = [
  "categoryId",
  "categoryName",
  "description",
  "detailSchemaKey",
  "details",
  "images",
  "inclusions",
  "listingKind",
  "location",
  "ownerInstructions",
  "rates",
  "securityDeposit",
  "showcase",
  "title",
  "subcategoryId",
  "subcategoryName",
];

function normalizeListingSubmission(raw, uid) {
  const data = raw && typeof raw === "object" ? raw : {};
  const submissionType = assertEnum(data.submissionType, ["create", "update"], "submissionType");
  const ownerId = cleanString(data.ownerId, "ownerId", 1, 160);

  if (ownerId !== uid) {
    throwAndLogHttpsError("permission-denied", "Listing owner does not match authenticated user");
  }

  const listing = data.listing && typeof data.listing === "object" ? data.listing : data;
  const assetId =
    submissionType === "update"
      ? cleanString(data.assetId || listing.id, "assetId", 1, 160)
      : cleanOptionalString(data.assetId || listing.id, 160);

  const normalized = {
    submissionType,
    assetId,
    ownerId,
    title: cleanString(listing.title, "title", 1, 120),
    description: cleanOptionalString(listing.description, 2000) || "",
    categoryId: cleanString(listing.categoryId, "categoryId", 1, 160),
    categoryName: cleanString(listing.categoryName, "categoryName", 1, 120),
    subcategoryId: cleanOptionalString(listing.subcategoryId, 160),
    subcategoryName: cleanOptionalString(listing.subcategoryName, 120),
    listingKind: cleanOptionalString(listing.listingKind, 80) || inferListingSchemaKey(listing),
    detailSchemaKey: cleanOptionalString(listing.detailSchemaKey, 80) || inferListingSchemaKey(listing),
    details: normalizeListingDetails(listing.details),
    rates: normalizeRates(listing.rates),
    location: normalizeLocation(listing.location),
    images: normalizeImagePaths(listing.images, "images", MAX_BANNER_IMAGES),
    showcase: normalizeImagePaths(listing.showcase, "showcase", MAX_SHOWCASE_IMAGES),
    inclusions: normalizeStringList(listing.inclusions, "inclusions", 30, 80),
    ownerInstructions: cleanOptionalString(listing.ownerInstructions, 1000),
    blocksEndDate: listing.blocksEndDate === true,
    status: cleanOptionalString(listing.status, 80) || "Available",
    securityDeposit: normalizeSecurityDeposit(listing.securityDeposit),
  };

  if (normalized.images.length === 0) {
    throwAndLogHttpsError("invalid-argument", "At least one listing image is required");
  }

  assertNoDuplicateImagePaths(normalized.images.concat(normalized.showcase));
  return normalized;
}

async function hydrateAndAssertCategoryMetadata({ db, submission }) {
  const categorySnap = await db.collection("categories").doc(submission.categoryId).get();
  if (!categorySnap.exists || categorySnap.data()?.isActive !== true) {
    throwAndLogHttpsError("failed-precondition", "Selected category is unavailable");
  }

  const category = categorySnap.data();
  if (category.parentId) {
    throwAndLogHttpsError("invalid-argument", "Select a parent category");
  }

  submission.categoryName = category.name;
  hydrateCategorySchemaMetadata({ submission, category });

  const childSnap = await db
    .collection("categories")
    .where("parentId", "==", submission.categoryId)
    .where("isActive", "==", true)
    .limit(1)
    .get();
  const requiresSubcategory = !childSnap.empty;

  if (requiresSubcategory && !submission.subcategoryId) {
    throwAndLogHttpsError("invalid-argument", "Selected category requires a subcategory");
  }

  if (!submission.subcategoryId) {
    submission.subcategoryName = null;
    return submission;
  }

  const subcategorySnap = await db.collection("categories").doc(submission.subcategoryId).get();
  const subcategory = subcategorySnap.data();
  if (!subcategorySnap.exists || subcategory?.isActive !== true || subcategory.parentId !== submission.categoryId) {
    throwAndLogHttpsError("failed-precondition", "Selected subcategory is unavailable");
  }
  submission.subcategoryName = subcategory.name;
  hydrateCategorySchemaMetadata({ submission, category: subcategory });
  return submission;
}

function hydrateCategorySchemaMetadata({ submission, category }) {
  const kind = cleanOptionalString(category.listingKind, 80);
  const schemaKey = cleanOptionalString(category.detailSchemaKey, 80);
  if (kind) submission.listingKind = kind;
  if (schemaKey) submission.detailSchemaKey = schemaKey;
}

async function assertOwnerCanSubmit({ db, uid, submission }) {
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) {
    throwAndLogHttpsError("failed-precondition", "User profile was not found");
  }

  const user = userSnap.data();
  if (user?.verified !== "Full") {
    throwAndLogHttpsError("failed-precondition", "Full verification is required to list assets");
  }

  if (submission.submissionType !== "update") return null;

  const assetRef = db.collection("assets").doc(submission.assetId);
  const assetSnap = await assetRef.get();
  if (!assetSnap.exists) {
    throwAndLogHttpsError("not-found", "Listing was not found");
  }

  const asset = assetSnap.data();
  if (asset?.ownerId !== uid) {
    throwAndLogHttpsError("permission-denied", "You can only update your own listings");
  }

  if (asset?.isDeleted === true) {
    throwAndLogHttpsError("failed-precondition", "Deleted listings cannot be updated");
  }

  return asset;
}

async function assertOwnerPayoutDestinationConfigured({ db, uid }) {
  const paymentSnap = await db.collection("users").doc(uid).collection("private").doc("payment").get();
  if (!paymentSnap.data()?.payoutDestination) {
    throwAndLogHttpsError("failed-precondition", "Add an owner payout destination before creating listings.");
  }
}

function assertImageRefsAllowed({ uid, submission, existingAsset = null }) {
  const refs = submission.images.concat(submission.showcase);
  if (submission.submissionType === "create") {
    assertAllDraftImagePathsOwnedByUser(uid, refs);
    return;
  }

  const existingImages = new Set([...(existingAsset?.images || []), ...(existingAsset?.showcase || [])]);
  const newDraftRefs = refs.filter((ref) => !existingImages.has(ref));
  assertAllDraftImagePathsOwnedByUser(uid, newDraftRefs);
}

async function verifyDraftImages({ bucket, paths }) {
  const uniquePaths = [...new Set(paths.filter((path) => !isHttpsUrl(path)))];
  await Promise.all(
    uniquePaths.map(async (path) => {
      const [exists] = await bucket.file(path).exists();
      if (!exists) {
        throwAndLogHttpsError("not-found", "A listing image was not found", { path });
      }
    }),
  );
}

async function buildImageReviewUrls({ bucket, paths }) {
  const uniquePaths = [...new Set(paths)];
  return Promise.all(
    uniquePaths.map(async (path) => {
      if (isHttpsUrl(path)) {
        return {
          path,
          url: path,
          contentType: "image/jpeg",
        };
      }

      const file = bucket.file(path);
      const [metadata] = await file.getMetadata();
      const contentType = metadata.contentType || contentTypeFromExtension(extensionFromPath(path));
      const size = Number(metadata.size || 0);
      if (size > MAX_REVIEW_IMAGE_BYTES) {
        throwAndLogHttpsError("invalid-argument", "A listing image is too large for review", { path });
      }

      const [buffer] = await file.download();
      if (buffer.length > MAX_REVIEW_IMAGE_BYTES) {
        throwAndLogHttpsError("invalid-argument", "A listing image is too large for review", { path });
      }

      return {
        path,
        url: `data:${contentType};base64,${buffer.toString("base64")}`,
        contentType,
      };
    }),
  );
}

async function copyApprovedImages({ bucket, listingId, images, showcase }) {
  const copied = new Map();

  async function copyOne(sourcePath) {
    if (copied.has(sourcePath)) return copied.get(sourcePath);
    if (isHttpsUrl(sourcePath)) {
      copied.set(sourcePath, sourcePath);
      return sourcePath;
    }

    const extension = extensionFromPath(sourcePath);
    const destinationPath = `listings/${listingId}/images/${uuidv4()}${extension}`;
    const token = uuidv4();
    await bucket.file(sourcePath).copy(bucket.file(destinationPath));
    await bucket.file(destinationPath).setMetadata({
      metadata: { firebaseStorageDownloadTokens: token },
      contentType: contentTypeFromExtension(extension),
    });
    const url = publicFirebaseDownloadUrl(bucket.name, destinationPath, token);
    copied.set(sourcePath, url);
    return url;
  }

  return {
    images: await Promise.all(images.map(copyOne)),
    showcase: await Promise.all(showcase.map(copyOne)),
  };
}

function buildAssetData({ submission, listingId, owner, imageUrls, existingAsset = null, now }) {
  const createdAt = existingAsset?.createdAt || now;
  return {
    id: listingId,
    ownerId: submission.ownerId,
    owner: buildSimpleOwner(owner, submission.ownerId),
    title: submission.title,
    description: submission.description,
    categoryId: submission.categoryId,
    categoryName: submission.categoryName,
    subcategoryId: submission.subcategoryId || null,
    subcategoryName: submission.subcategoryName || null,
    listingKind: submission.listingKind || null,
    detailSchemaKey: submission.detailSchemaKey || null,
    details: submission.details || {},
    rates: submission.rates,
    location: submission.location,
    images: imageUrls.images,
    showcase: imageUrls.showcase,
    inclusions: submission.inclusions,
    ownerInstructions: submission.ownerInstructions || null,
    blocksEndDate: submission.blocksEndDate,
    createdAt,
    updatedAt: now,
    status: submission.status,
    isDeleted: false,
    averageRating: existingAsset?.averageRating || null,
    reviewCount: existingAsset?.reviewCount || null,
    securityDeposit: submission.securityDeposit,
  };
}

function buildSimpleAssetData(asset) {
  return {
    id: asset.id,
    owner: asset.owner || null,
    title: asset.title,
    images: asset.images,
    categoryId: asset.categoryId,
    categoryName: asset.categoryName,
    subcategoryId: asset.subcategoryId || null,
    subcategoryName: asset.subcategoryName || null,
    listingKind: asset.listingKind || null,
    detailSchemaKey: asset.detailSchemaKey || null,
    details: asset.details || {},
    rates: asset.rates,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    status: asset.status,
    location: asset.location || null,
    isDeleted: asset.isDeleted === true,
    pendingBookingCount: 0,
    securityDeposit: asset.securityDeposit || { enabled: false, amount: 0 },
    ownerInstructions: asset.ownerInstructions || null,
    blocksEndDate: asset.blocksEndDate === true,
  };
}

function buildReviewQueueData({ submissionId, submission, review, uid, now, ownerComplianceRisk = null }) {
  return {
    id: submissionId,
    assetId: submission.assetId || null,
    ownerId: uid,
    submissionType: submission.submissionType,
    listing: submission,
    ownerComplianceRisk,
    aiReview: review,
    status: LISTING_REVIEW_STATUS.pending,
    submittedAt: now,
    updatedAt: now,
    reviewedAt: null,
    reviewedBy: null,
    adminNotes: null,
  };
}

function buildInitialReviewSubmissionData({ submissionId, submission, uid, now, ownerComplianceRisk = null }) {
  return {
    id: submissionId,
    assetId: submission.assetId || null,
    ownerId: uid,
    submissionType: submission.submissionType,
    listing: submission,
    ownerComplianceRisk,
    aiReview: null,
    status: LISTING_REVIEW_STATUS.queued,
    submittedAt: now,
    updatedAt: now,
    reviewedAt: null,
    reviewedBy: null,
    adminNotes: null,
    approvedAssetId: null,
  };
}

async function buildOwnerComplianceRisk({ db, uid, submission, now = new Date() }) {
  const checkedAt = now;
  const ownerSnap = await db.collection("users").doc(uid).get();
  if (hasApprovedBusinessRegistration(ownerSnap.data())) {
    return {
      triggered: false,
      reasons: [],
      metrics: null,
      thresholds: { ...OWNER_COMPLIANCE_THRESHOLDS },
      activeStatuses: OWNER_COMPLIANCE_ACTIVE_STATUSES,
      checkedAt,
      complianceSatisfiedBy: "approved_business_registration",
    };
  }

  const since = new Date(toDate(checkedAt).getTime() - 30 * 24 * 60 * 60 * 1000);
  const activeListings = await getOwnerActiveListings({ db, uid, submission });
  const recentBookingMetrics = await getOwnerRecentBookingMetrics({
    activeListings,
    db,
    since,
  });

  const metrics = {
    activeListingCount: activeListings.length,
    highValueActiveListingCount: activeListings.filter(isHighValueListing).length,
    recentBookingCount30d: recentBookingMetrics.count,
    recentGrossRentalAmount30d: recentBookingMetrics.grossRentalAmount,
    regulatedPortfolioCount: activeListings.filter(isRegulatedListing).length,
  };
  const thresholds = { ...OWNER_COMPLIANCE_THRESHOLDS };
  const reasons = buildOwnerComplianceRiskReasons({ metrics, thresholds });

  return {
    triggered: reasons.length > 0,
    reasons,
    metrics,
    thresholds,
    activeStatuses: OWNER_COMPLIANCE_ACTIVE_STATUSES,
    checkedAt,
  };
}

function hasApprovedBusinessRegistration(user) {
  return user?.businessRegistration?.status === "Approved";
}

async function getOwnerActiveListings({ db, uid, submission }) {
  const snap = await db.collection("users").doc(uid).collection("assets").get();
  const listings = [];

  snap.forEach((doc) => {
    const listing = { ...(doc.data() || {}), id: doc.id };
    if (listing.id === submission.assetId) return;
    if (isOwnerComplianceActiveListing(listing)) listings.push(listing);
  });

  if (isOwnerComplianceActiveListing(submission)) {
    listings.push(submission);
  }

  return listings;
}

async function getOwnerRecentBookingMetrics({ activeListings, db, since }) {
  let count = 0;
  let grossRentalAmount = 0;

  await Promise.all(
    activeListings.map(async (listing) => {
      if (!listing.id) return;
      const snap = await db
        .collection("assets")
        .doc(listing.id)
        .collection("bookings")
        .where("createdAt", ">=", admin.firestore.Timestamp?.fromDate(since) || since)
        .get();

      snap.forEach((doc) => {
        const booking = doc.data() || {};
        if (isExcludedOwnerComplianceBookingStatus(booking.status)) return;
        count += 1;
        grossRentalAmount += bookingGrossRentalAmount(booking);
      });
    }),
  );

  return { count, grossRentalAmount };
}

function buildOwnerComplianceRiskReasons({ metrics, thresholds }) {
  const reasons = [];
  if (metrics.highValueActiveListingCount >= thresholds.highValueActiveListingCount) {
    reasons.push(
      `${metrics.highValueActiveListingCount} active high-value listings may require permit, tax, license, insurance, or ownership document review.`,
    );
  }
  if (metrics.recentBookingCount30d >= thresholds.recentBookingCount30d) {
    reasons.push(
      `${metrics.recentBookingCount30d} bookings in the last 30 days may require volume-based compliance review.`,
    );
  }
  if (metrics.recentGrossRentalAmount30d >= thresholds.recentGrossRentalAmount30d) {
    reasons.push(
      `PHP ${metrics.recentGrossRentalAmount30d} gross rentals in the last 30 days may require earnings, tax, or permit review.`,
    );
  }
  if (metrics.regulatedPortfolioCount >= thresholds.regulatedPortfolioCount) {
    reasons.push(
      `${metrics.regulatedPortfolioCount} active stay, space, or vehicle listings may indicate fleet or multiple-property behavior requiring document review.`,
    );
  }
  return reasons;
}

function buildOwnerComplianceManualReview(ownerComplianceRisk) {
  return {
    decision: "manual_review",
    severity: "medium",
    categories: ["owner_compliance_document_review"],
    reasons:
      ownerComplianceRisk?.reasons?.length > 0
        ? ownerComplianceRisk.reasons
        : [
            "Owner activity may require permit, tax, licensing, insurance, property, transport, LGU, or other compliance document review.",
          ],
  };
}

function isOwnerComplianceActiveListing(listing) {
  return listing?.isDeleted !== true && OWNER_COMPLIANCE_ACTIVE_STATUSES.includes(listing?.status || "");
}

function isHighValueListing(listing) {
  const daily = Number(listing?.rates?.daily || 0);
  const deposit = listing?.securityDeposit || {};
  const depositAmount = deposit.enabled === true ? Number(deposit.amount || 0) : 0;
  return (
    daily >= OWNER_COMPLIANCE_THRESHOLDS.highValueDailyRate ||
    depositAmount >= OWNER_COMPLIANCE_THRESHOLDS.highValueSecurityDeposit
  );
}

function isRegulatedListing(listing) {
  return OWNER_COMPLIANCE_REGULATED_SCHEMA_KEYS.includes(listing?.detailSchemaKey || "");
}

function isExcludedOwnerComplianceBookingStatus(status) {
  return ["Cancelled", "Canceled", "Failed", "Expired"].includes(status || "");
}

function bookingGrossRentalAmount(booking) {
  const rentalSubtotal = Number(booking?.priceBreakdown?.rentalSubtotal);
  if (Number.isFinite(rentalSubtotal) && rentalSubtotal > 0) return rentalSubtotal;
  const totalPrice = Number(booking?.totalPrice);
  return Number.isFinite(totalPrice) && totalPrice > 0 ? totalPrice : 0;
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (value && typeof value.toDate === "function") return value.toDate();
  return new Date();
}

async function createOrUpdatePublicListing({ db, bucket, submission, owner, review, existingAsset = null }) {
  const listingId =
    submission.submissionType === "update"
      ? submission.assetId
      : submission.assetId || db.collection("assets").doc().id;
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  const imageUrls = await copyApprovedImages({
    bucket,
    listingId,
    images: submission.images,
    showcase: submission.showcase,
  });
  const asset = buildAssetData({ submission, listingId, owner, imageUrls, existingAsset, now });
  const simpleAsset = buildSimpleAssetData(asset);
  const batch = db.batch();
  const assetRef = db.collection("assets").doc(listingId);
  const ownerAssetRef = db.collection("users").doc(submission.ownerId).collection("assets").doc(listingId);

  batch.set(assetRef, asset, { merge: submission.submissionType === "update" });
  batch.set(ownerAssetRef, simpleAsset, { merge: true });
  batch.set(assetRef.collection("audits").doc(), {
    type: submission.submissionType === "update" ? "Edited" : "Approved",
    notes: `AI moderation ${review.decision}: ${review.reasons.join("; ") || "No reasons provided."}`,
    createdBy: { uid: "system", name: "AI Moderation" },
    createdAt: now,
  });
  await batch.commit();

  return { listingId, asset };
}

function buildListingReviewNotification({ queueItem, submissionId }) {
  const review = queueItem.aiReview || {};
  const reasons = Array.isArray(review.reasons) ? review.reasons.filter(Boolean) : [];
  const title = "Listing rejected";
  const listingTitle = queueItem.listing?.title || "Your listing";
  const body = reasons[0] || `${listingTitle} was not approved for publication.`;

  return {
    uid: queueItem.ownerId,
    title,
    body,
    imageUrl: firstListingImageUrl(queueItem.listing),
    data: {
      type: "listing_review",
      target: "listingReviewResult",
      submissionId,
      decision: "reject",
    },
    persist: true,
    push: true,
  };
}

function buildListingApprovedNotification({ queueItem, assetId }) {
  return {
    uid: queueItem.ownerId,
    title: "Listing approved",
    body: "This listing is now publicly available",
    imageUrl: firstListingImageUrl(queueItem.listing),
    data: {
      type: "listing_review",
      target: "asset",
      assetId,
      decision: "approve",
    },
    persist: true,
    push: true,
  };
}

async function deleteDraftImages({ bucket, submission }) {
  const paths = [
    ...new Set([...(submission?.images || []), ...(submission?.showcase || [])].filter((path) => !isHttpsUrl(path))),
  ];
  if (paths.length === 0) return;
  await Promise.allSettled(paths.map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
}

async function approveQueuedSubmission({ db, bucket, queueItem, adminUser, notes }) {
  const submission = queueItem.listing;
  const ownerSnap = await db.collection("users").doc(queueItem.ownerId).get();
  const existingAsset =
    submission.submissionType === "update"
      ? (await db.collection("assets").doc(submission.assetId).get()).data()
      : null;
  const result = await createOrUpdatePublicListing({
    db,
    bucket,
    submission,
    owner: ownerSnap.data(),
    review: queueItem.aiReview || { decision: "manual_review", reasons: [] },
    existingAsset,
  });
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();

  await db
    .collection("listingReviewSubmissions")
    .doc(queueItem.id)
    .set(
      {
        status: LISTING_REVIEW_STATUS.approved,
        reviewedAt: now,
        updatedAt: now,
        reviewedBy: adminUser,
        adminNotes: notes || "",
        approvedAssetId: result.listingId,
      },
      { merge: true },
    );

  await db
    .collection("assets")
    .doc(result.listingId)
    .collection("audits")
    .doc()
    .set({
      type: "Approved",
      notes: notes || "Approved from listing review queue.",
      createdBy: adminUser,
      createdAt: now,
    });

  await sendNotificationToUser(
    buildListingApprovedNotification({
      queueItem,
      assetId: result.listingId,
    }),
  );

  return result;
}

function normalizeRates(value) {
  const rates = value && typeof value === "object" ? value : {};
  return {
    daily: cleanPositiveInt(rates.daily, "rates.daily"),
    weekly: cleanOptionalPositiveInt(rates.weekly),
    monthly: cleanOptionalPositiveInt(rates.monthly),
    annually: cleanOptionalPositiveInt(rates.annually),
    notes: cleanOptionalString(rates.notes, 500),
    currency: cleanOptionalString(rates.currency, 8),
  };
}

function normalizeLocation(value) {
  if (!value || typeof value !== "object") {
    throwAndLogHttpsError("invalid-argument", "Listing location is required");
  }
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throwAndLogHttpsError("invalid-argument", "Listing location must include coordinates");
  }
  return cleanObject(value, [
    "plusCode",
    "streetNumber",
    "route",
    "locality",
    "administrativeAreaLevel2",
    "administrativeAreaLevel1",
    "country",
    "countryShortName",
    "postalCode",
    "formattedAddress",
    "lat",
    "lng",
    "geohash",
  ]);
}

function normalizeImagePaths(value, fieldName, maxCount) {
  if (!Array.isArray(value)) {
    throwAndLogHttpsError("invalid-argument", `${fieldName} must be a list`);
  }
  if (value.length > maxCount) {
    throwAndLogHttpsError("invalid-argument", `${fieldName} has too many images`);
  }
  return value.map((item) => cleanString(item, fieldName, 1, 512));
}

function normalizeStringList(value, fieldName, maxCount, maxLength) {
  if (!Array.isArray(value)) return [];
  if (value.length > maxCount) {
    throwAndLogHttpsError("invalid-argument", `${fieldName} has too many items`);
  }
  return value.map((item) => cleanString(item, fieldName, 1, maxLength));
}

function normalizeSecurityDeposit(value) {
  const deposit = value && typeof value === "object" ? value : {};
  const enabled = deposit.enabled === true;
  const amount = enabled ? cleanPositiveInt(deposit.amount, "securityDeposit.amount") : 0;
  return { enabled, amount };
}

function normalizeListingDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value)
    .slice(0, 80)
    .map(([key, rawValue]) => [cleanString(key, "details key", 1, 80), normalizeListingDetailsValue(rawValue)])
    .filter(([, item]) => item !== undefined);
  return Object.fromEntries(entries);
}

function normalizeListingDetailsValue(value) {
  if (value == null) return null;
  if (typeof value === "string") return value.trim().slice(0, 500);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map(normalizeListingDetailsValue)
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object") return normalizeListingDetails(value);
  return undefined;
}

function inferListingSchemaKey(listing) {
  const text = [
    listing.detailSchemaKey,
    listing.listingKind,
    listing.subcategoryId,
    listing.subcategoryName,
    listing.categoryId,
    listing.categoryName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/stay|house|apartment|condo|room/.test(text)) return "stay";
  if (/space|studio|parking|storage/.test(text)) return "space";
  if (/vehicle|car/.test(text)) return "vehicle";
  if (/tool/.test(text)) return "tool";
  if (/electronics|camera|drone/.test(text)) return "electronics";
  if (/party|event/.test(text)) return "party_event";
  if (/clothing|apparel/.test(text)) return "clothing";
  return "generic_asset";
}

function assertAllDraftImagePathsOwnedByUser(uid, paths) {
  if (paths.length > MAX_TOTAL_IMAGES) {
    throwAndLogHttpsError("invalid-argument", "Too many listing images");
  }
  const prefix = `users/${uid}/listingDrafts/`;
  for (const path of paths) {
    if (isHttpsUrl(path)) {
      throwAndLogHttpsError("permission-denied", "New listing images must be uploaded to your draft path");
    }
    if (!path.startsWith(prefix)) {
      throwAndLogHttpsError("permission-denied", "Listing images must be uploaded to your draft path");
    }
    if (!/\/images\/[^/]+\.(jpg|jpeg|png|webp)$/i.test(path)) {
      throwAndLogHttpsError("invalid-argument", "Listing image path is invalid");
    }
  }
}

function isHttpsUrl(value) {
  return typeof value === "string" && value.startsWith("https://");
}

function assertNoDuplicateImagePaths(paths) {
  if (new Set(paths).size !== paths.length) {
    throwAndLogHttpsError("invalid-argument", "Listing images must not contain duplicates");
  }
}

function buildSimpleOwner(user, uid) {
  const displayName = resolveMarketplaceDisplayName(user);
  return {
    uid,
    firstName: cleanNullable(user?.firstName),
    lastName: cleanNullable(user?.lastName),
    displayName: cleanNullable(displayName),
    photoUrl: cleanNullable(user?.photoUrl),
    verified: cleanNullable(user?.verified) || "Full",
    userMetadataVersion: Number.isInteger(user?.userMetadataVersion) ? user.userMetadataVersion : 1,
  };
}

function resolveMarketplaceDisplayName(user) {
  const businessName = cleanNullable(user?.businessRegistration?.businessName);
  const businessApproved = user?.businessRegistration?.status === "Approved";
  return user?.useBusinessNameForListingOwnerName === true && businessApproved && businessName ? businessName : null;
}

function cleanObject(value, allowedKeys) {
  return Object.fromEntries(
    allowedKeys.filter((key) => value[key] !== undefined && value[key] !== null).map((key) => [key, value[key]]),
  );
}

function cleanString(value, fieldName, minLength, maxLength) {
  if (typeof value !== "string") {
    throwAndLogHttpsError("invalid-argument", `${fieldName} must be a string`);
  }
  const text = value.trim();
  if (text.length < minLength || text.length > maxLength) {
    throwAndLogHttpsError("invalid-argument", `${fieldName} is invalid`);
  }
  return text;
}

function cleanOptionalString(value, maxLength) {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function cleanNullable(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanPositiveInt(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throwAndLogHttpsError("invalid-argument", `${fieldName} must be a positive integer`);
  }
  return number;
}

function cleanOptionalPositiveInt(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function assertEnum(value, allowed, fieldName) {
  if (!allowed.includes(value)) {
    throwAndLogHttpsError("invalid-argument", `${fieldName} is invalid`);
  }
  return value;
}

function extensionFromPath(path) {
  const match = path.match(/\.(jpg|jpeg|png|webp)$/i);
  return match ? `.${match[1].toLowerCase()}` : ".jpg";
}

function contentTypeFromExtension(extension) {
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

function publicFirebaseDownloadUrl(bucketName, path, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

module.exports = {
  LISTING_REVIEW_STATUS,
  MODERATED_ASSET_FIELDS,
  OWNER_COMPLIANCE_ACTIVE_STATUSES,
  OWNER_COMPLIANCE_THRESHOLDS,
  approveQueuedSubmission,
  assertImageRefsAllowed,
  assertOwnerCanSubmit,
  assertOwnerPayoutDestinationConfigured,
  buildOwnerComplianceManualReview,
  buildOwnerComplianceRisk,
  buildImageReviewUrls,
  buildInitialReviewSubmissionData,
  buildListingApprovedNotification,
  buildListingReviewNotification,
  buildReviewQueueData,
  buildSimpleAssetData,
  copyApprovedImages,
  createOrUpdatePublicListing,
  deleteDraftImages,
  hasApprovedBusinessRegistration,
  hydrateAndAssertCategoryMetadata,
  normalizeListingSubmission,
  verifyDraftImages,
  _test: {
    assertAllDraftImagePathsOwnedByUser,
    assertImageRefsAllowed,
    assertOwnerPayoutDestinationConfigured,
    bookingGrossRentalAmount,
    buildAssetData,
    buildInitialReviewSubmissionData,
    buildListingApprovedNotification,
    buildListingReviewNotification,
    buildOwnerComplianceManualReview,
    buildOwnerComplianceRisk,
    buildOwnerComplianceRiskReasons,
    buildSimpleAssetData,
    hydrateAndAssertCategoryMetadata,
    hasApprovedBusinessRegistration,
    inferListingSchemaKey,
    isHighValueListing,
    isOwnerComplianceActiveListing,
    isRegulatedListing,
    normalizeListingDetails,
    normalizeListingSubmission,
    publicFirebaseDownloadUrl,
  },
};
