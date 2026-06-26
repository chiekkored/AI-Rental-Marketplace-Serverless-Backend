const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const { firstListingImageUrl, sendNotificationToUser } = require("../utils/notification.util");

const LISTING_MODERATION_COLLECTION = "listingModerationEvents";
const LISTING_MODERATION_ACTION = "Deleted";
const MAX_REASON_LENGTH = 2000;

async function adminDeleteListing(request) {
  const uid = request.auth?.uid;
  const token = request.auth?.token || {};

  if (!uid || token.admin !== true) {
    throwAndLogHttpsError("permission-denied", "Admin access is required");
  }

  try {
    const input = normalizeDeleteListingInput(request.data);
    const db = admin.firestore();
    const assetRef = db.collection("assets").doc(input.assetId);
    const assetSnap = await assetRef.get();

    if (!assetSnap.exists) {
      throwAndLogHttpsError("not-found", "Listing not found");
    }

    const listing = assetSnap.data() || {};
    const ownerId = cleanOwnerId(listing.ownerId || listing.owner?.uid);
    if (!ownerId) {
      throwAndLogHttpsError("failed-precondition", "Listing is missing an owner");
    }

    const now = admin.firestore?.FieldValue?.serverTimestamp() || new Date();
    const adminUser = {
      uid,
      name: token.name || token.email || uid,
    };
    const eventRef = db.collection("users").doc(ownerId).collection(LISTING_MODERATION_COLLECTION).doc();
    const ownerAssetRef = db.collection("users").doc(ownerId).collection("assets").doc(input.assetId);
    const auditRef = assetRef.collection("audits").doc();
    const listingSnapshot = buildDeletedListingSnapshot({
      assetId: input.assetId,
      listing,
    });
    const batch = db.batch();

    batch.set(
      assetRef,
      {
        isDeleted: true,
        updatedAt: now,
      },
      { merge: true },
    );
    batch.set(
      ownerAssetRef,
      {
        isDeleted: true,
        updatedAt: now,
      },
      { merge: true },
    );
    batch.set(auditRef, {
      createdAt: now,
      createdBy: adminUser,
      notes: input.reason,
      type: LISTING_MODERATION_ACTION,
    });
    batch.set(eventRef, {
      action: LISTING_MODERATION_ACTION,
      assetId: input.assetId,
      createdAt: now,
      createdBy: adminUser,
      listingSnapshot,
      reason: input.reason,
    });

    await batch.commit();
    await sendNotificationToUser(
      buildListingDeletedNotification({
        assetId: input.assetId,
        eventId: eventRef.id,
        listing: listingSnapshot,
        ownerId,
      }),
    );

    return {
      assetId: input.assetId,
      deleted: true,
      eventId: eventRef.id,
    };
  } catch (error) {
    console.error(`[adminDeleteListing] Error: ${error.message}`);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throwAndLogHttpsError("internal", "Unable to delete listing", error.message);
  }
}

function normalizeDeleteListingInput(data) {
  const input = data && typeof data === "object" ? data : {};
  const assetId = cleanString(input.assetId, 1, 160);
  const reason = cleanString(input.reason, 1, MAX_REASON_LENGTH);

  if (!assetId) {
    throwAndLogHttpsError("invalid-argument", "Missing listing");
  }
  if (!reason) {
    throwAndLogHttpsError("invalid-argument", "Missing deletion reason");
  }

  return { assetId, reason };
}

function buildListingDeletedNotification({ assetId, eventId, listing, ownerId }) {
  return {
    uid: ownerId,
    title: "Listing deleted",
    body: "Your listing was deleted due to violation of Lend terms and policies.",
    imageUrl: firstListingImageUrl(listing),
    data: {
      type: "listing_moderation",
      target: "deletedListing",
      action: "deleted",
      assetId,
      eventId,
    },
    persist: true,
    push: true,
  };
}

function buildDeletedListingSnapshot({ assetId, listing }) {
  return {
    id: assetId,
    ownerId: listing.ownerId || listing.owner?.uid || null,
    owner: listing.owner || null,
    title: cleanOptionalString(listing.title, 160) || "Untitled listing",
    description: cleanOptionalString(listing.description, 2000) || "",
    categoryId: cleanOptionalString(listing.categoryId, 160),
    categoryName: cleanOptionalString(listing.categoryName, 160),
    subcategoryId: cleanOptionalString(listing.subcategoryId, 160),
    subcategoryName: cleanOptionalString(listing.subcategoryName, 160),
    listingKind: cleanOptionalString(listing.listingKind, 80),
    detailSchemaKey: cleanOptionalString(listing.detailSchemaKey, 80),
    details: cleanPlainObject(listing.details),
    rates: cleanPlainObject(listing.rates),
    location: cleanPlainObject(listing.location),
    images: cleanStringList(listing.images, 12, 512),
    showcase: cleanStringList(listing.showcase, 12, 512),
    inclusions: cleanStringList(listing.inclusions, 30, 120),
    ownerInstructions: cleanOptionalString(listing.ownerInstructions, 1000),
    blocksEndDate: listing.blocksEndDate === true,
    createdAt: listing.createdAt || null,
    status: listing.status || null,
    isDeleted: true,
    averageRating: typeof listing.averageRating === "number" ? listing.averageRating : null,
    reviewCount: Number.isInteger(listing.reviewCount) ? listing.reviewCount : null,
    securityDeposit: cleanPlainObject(listing.securityDeposit) || { enabled: false, amount: 0 },
  };
}

function cleanOwnerId(value) {
  return cleanOptionalString(value, 160);
}

function cleanString(value, minLength, maxLength) {
  const normalized = cleanOptionalString(value, maxLength);
  return normalized && normalized.length >= minLength ? normalized : "";
}

function cleanOptionalString(value, maxLength) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().slice(0, maxLength);
  return normalized.length > 0 ? normalized : null;
}

function cleanStringList(value, maxCount, maxLength) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxCount)
    .map((item) => cleanOptionalString(item, maxLength))
    .filter(Boolean);
}

function cleanPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

module.exports = {
  adminDeleteListing,
  _test: {
    buildDeletedListingSnapshot,
    buildListingDeletedNotification,
    normalizeDeleteListingInput,
  },
};
