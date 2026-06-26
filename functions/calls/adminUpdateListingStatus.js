const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const { firstListingImageUrl, sendNotificationToUser } = require("../utils/notification.util");

const LISTING_MODERATION_COLLECTION = "listingModerationEvents";
const LISTING_STATUS_ACTION = "Status Updated";
const ARCHIVE_ACTION = "Archived";
const MAX_REASON_LENGTH = 2000;
const ALLOWED_STATUSES = ["Available", "Under Maintenance", "Hidden", "Archived"];

async function adminUpdateListingStatus(request) {
  const uid = request.auth?.uid;
  const token = request.auth?.token || {};

  if (!uid || token.admin !== true) {
    throwAndLogHttpsError("permission-denied", "Admin access is required");
  }

  try {
    const input = normalizeUpdateListingStatusInput(request.data);
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

    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
    const adminUser = {
      uid,
      name: token.name || token.email || uid,
    };
    const ownerAssetRef = db.collection("users").doc(ownerId).collection("assets").doc(input.assetId);
    const auditRef = assetRef.collection("audits").doc();
    const batch = db.batch();
    let eventRef = null;
    const listingSnapshot = buildListingSnapshot({
      assetId: input.assetId,
      listing: {
        ...listing,
        status: input.status,
      },
    });

    batch.set(
      assetRef,
      {
        status: input.status,
        updatedAt: now,
      },
      { merge: true },
    );
    batch.set(
      ownerAssetRef,
      {
        status: input.status,
        updatedAt: now,
      },
      { merge: true },
    );
    batch.set(auditRef, {
      createdAt: now,
      createdBy: adminUser,
      notes: buildAuditNotes({
        previousStatus: listing.status || "Not set",
        reason: input.reason,
        status: input.status,
      }),
      type: input.status === "Archived" ? ARCHIVE_ACTION : LISTING_STATUS_ACTION,
    });

    if (input.status === "Archived") {
      eventRef = db.collection("users").doc(ownerId).collection(LISTING_MODERATION_COLLECTION).doc();
      batch.set(eventRef, {
        action: ARCHIVE_ACTION,
        assetId: input.assetId,
        createdAt: now,
        createdBy: adminUser,
        listingSnapshot,
        reason: input.reason,
      });
    }

    await batch.commit();
    await sendNotificationToUser(
      input.status === "Archived"
        ? buildListingArchivedNotification({
            assetId: input.assetId,
            eventId: eventRef.id,
            listing: listingSnapshot,
            ownerId,
          })
        : buildListingStatusNotification({
            assetId: input.assetId,
            listing: listingSnapshot,
            ownerId,
            status: input.status,
          }),
    );

    return {
      assetId: input.assetId,
      eventId: eventRef?.id || null,
      status: input.status,
      updated: true,
    };
  } catch (error) {
    console.error(`[adminUpdateListingStatus] Error: ${error.message}`);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throwAndLogHttpsError("internal", "Unable to update listing status", error.message);
  }
}

function normalizeUpdateListingStatusInput(data) {
  const input = data && typeof data === "object" ? data : {};
  const assetId = cleanString(input.assetId, 1, 160);
  const status = cleanString(input.status, 1, 80);
  const reason = cleanOptionalString(input.reason, MAX_REASON_LENGTH) || "";

  if (!assetId) {
    throwAndLogHttpsError("invalid-argument", "Missing listing");
  }
  if (!ALLOWED_STATUSES.includes(status)) {
    throwAndLogHttpsError("invalid-argument", "Invalid listing status");
  }
  if (status === "Archived" && !reason) {
    throwAndLogHttpsError("invalid-argument", "Archive reason is required");
  }

  return { assetId, reason, status };
}

function buildListingStatusNotification({ assetId, listing, ownerId, status }) {
  return {
    uid: ownerId,
    title: "Listing status updated",
    body: `Your listing status was updated to ${status}.`,
    imageUrl: firstListingImageUrl(listing),
    data: {
      type: "listing_moderation",
      target: "asset",
      assetId,
      status,
    },
    persist: true,
    push: true,
  };
}

function buildListingArchivedNotification({ assetId, eventId, listing, ownerId }) {
  return {
    uid: ownerId,
    title: "Listing archived",
    body: "Your listing was archived by Lend Support. Open Lend to review the reason.",
    imageUrl: firstListingImageUrl(listing),
    data: {
      type: "listing_moderation",
      target: "deletedListing",
      action: "archived",
      assetId,
      eventId,
    },
    persist: true,
    push: true,
  };
}

function buildListingSnapshot({ assetId, listing }) {
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
    isDeleted: listing.isDeleted === true,
    averageRating: typeof listing.averageRating === "number" ? listing.averageRating : null,
    reviewCount: Number.isInteger(listing.reviewCount) ? listing.reviewCount : null,
    securityDeposit: cleanPlainObject(listing.securityDeposit) || { enabled: false, amount: 0 },
  };
}

function buildAuditNotes({ previousStatus, reason, status }) {
  const statusChange = `Status: ${previousStatus} -> ${status}`;
  return reason ? `${statusChange}\nReason: ${reason}` : statusChange;
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
  adminUpdateListingStatus,
  _test: {
    ALLOWED_STATUSES,
    buildAuditNotes,
    buildListingArchivedNotification,
    buildListingSnapshot,
    buildListingStatusNotification,
    normalizeUpdateListingStatusInput,
  },
};
