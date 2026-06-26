const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { BOOKING_STATUS, parseFirestoreDate, normalizeToDay } = require("../utils/booking.util");
const { throwAndLogHttpsError } = require("../utils/error.util");
const { firstListingImageUrl, sendNotificationToUser } = require("../utils/notification.util");
const {
  _adminCancelBookingWithFullRefund,
  _adminDeclineBookingWithoutRefund,
} = require("./cancelBooking");

const LISTING_STATUS = {
  archived: "Archived",
  hidden: "Hidden",
  underMaintenance: "Under Maintenance",
};

const DEACTIVATION_REQUEST_STATUS = {
  approved: "Approved",
  pending: "Pending",
  rejected: "Rejected",
};

const FUTURE_BLOCKING_BOOKING_STATUSES = [
  BOOKING_STATUS.pending,
  BOOKING_STATUS.confirmed,
  BOOKING_STATUS.cancellationRequested,
];

const MAX_EVIDENCE_URLS = 6;

async function getListingDeletionEligibility(request) {
  try {
    const auth = request.auth;
    const { assetId } = request.data || {};
    assertSignedIn(auth);
    const normalizedAssetId = normalizeRequiredText(assetId, "assetId", 160);
    const db = admin.firestore();
    const assetSnap = await db.collection("assets").doc(normalizedAssetId).get();
    if (!assetSnap.exists || assetSnap.data()?.isDeleted === true) {
      throwAndLogHttpsError("not-found", "Listing not found");
    }

    const listing = assetSnap.data();
    assertListingOwner(auth.uid, listing);
    const blockingBookings = await fetchFutureBlockingBookings({ assetId: normalizedAssetId, db });

    return buildDeletionEligibilityResult(blockingBookings);
  } catch (error) {
    rethrowCallableError(error, "Unable to check listing deletion eligibility");
  }
}

async function deleteListing(request) {
  try {
    const auth = request.auth;
    const { assetId } = request.data || {};
    assertSignedIn(auth);
    const normalizedAssetId = normalizeRequiredText(assetId, "assetId", 160);
    const db = admin.firestore();
    const assetRef = db.collection("assets").doc(normalizedAssetId);
    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();

    await db.runTransaction(async (tx) => {
      const assetSnap = await tx.get(assetRef);
      if (!assetSnap.exists || assetSnap.data()?.isDeleted === true) {
        throwAndLogHttpsError("not-found", "Listing not found");
      }

      const listing = assetSnap.data();
      assertListingOwner(auth.uid, listing);
      assertListingNotLocked(listing);

      const bookingSnap = await tx.get(futureBlockingBookingsQuery({ assetId: normalizedAssetId, db }));
      const blockingBookings = filterFutureBlockingBookings(bookingSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
      if (blockingBookings.length > 0) {
        throwAndLogHttpsError("failed-precondition", "Listing has upcoming bookings");
      }

      tx.set(assetRef, { isDeleted: true, updatedAt: now }, { merge: true });
      tx.set(
        db.collection("users").doc(auth.uid).collection("assets").doc(normalizedAssetId),
        { isDeleted: true, updatedAt: now },
        { merge: true },
      );
      tx.set(assetRef.collection("audits").doc(), {
        createdAt: now,
        createdBy: { name: auth.token?.name || auth.token?.email || auth.uid, uid: auth.uid },
        notes: "Owner deleted listing after deletion eligibility check.",
        type: "Deleted",
      });
    });

    return { success: true };
  } catch (error) {
    rethrowCallableError(error, "Unable to delete listing");
  }
}

async function requestListingDeactivationReview(request) {
  try {
    const auth = request.auth;
    const { assetId, evidenceUrls, notes, reason, requestId } = request.data || {};
    assertSignedIn(auth);
    const normalizedRequestId = normalizeRequiredText(requestId, "requestId", 160);
    const normalizedAssetId = normalizeRequiredText(assetId, "assetId", 160);
    const normalizedReason = normalizeRequiredText(reason, "reason", 120);
    const normalizedNotes = normalizeRequiredText(notes, "notes", 1000);
    const normalizedEvidenceUrls = normalizeEvidenceUrls(evidenceUrls, auth.uid, normalizedRequestId);
    const db = admin.firestore();
    const assetRef = db.collection("assets").doc(normalizedAssetId);
    const requestRef = db.collection("listingDeactivationRequests").doc(normalizedRequestId);
    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
    let result = null;

    await db.runTransaction(async (tx) => {
      const [assetSnap, requestSnap] = await Promise.all([tx.get(assetRef), tx.get(requestRef)]);
      if (requestSnap.exists) {
        throwAndLogHttpsError("already-exists", "Deactivation request already exists");
      }
      if (!assetSnap.exists || assetSnap.data()?.isDeleted === true) {
        throwAndLogHttpsError("not-found", "Listing not found");
      }

      const listing = assetSnap.data();
      assertListingOwner(auth.uid, listing);
      assertListingNotLocked(listing);
      if (listing?.deactivationReview?.status === DEACTIVATION_REQUEST_STATUS.pending) {
        throwAndLogHttpsError("already-exists", "Listing already has a pending deactivation request");
      }

      const bookingSnap = await tx.get(futureBlockingBookingsQuery({ assetId: normalizedAssetId, db }));
      const blockingBookings = filterFutureBlockingBookings(bookingSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
      if (blockingBookings.length === 0) {
        throwAndLogHttpsError("failed-precondition", "Listing has no upcoming bookings and can be deleted normally");
      }

      const pendingStatus = listing.status === LISTING_STATUS.hidden
        ? LISTING_STATUS.hidden
        : LISTING_STATUS.underMaintenance;
      const requestData = buildDeactivationRequestData({
        assetId: normalizedAssetId,
        blockingBookings,
        evidenceUrls: normalizedEvidenceUrls,
        listing,
        notes: normalizedNotes,
        now,
        ownerId: auth.uid,
        reason: normalizedReason,
        requestId: normalizedRequestId,
      });

      tx.set(requestRef, requestData);
      tx.set(
        assetRef,
        {
          deactivationReview: {
            requestId: normalizedRequestId,
            requestedAt: now,
            status: DEACTIVATION_REQUEST_STATUS.pending,
          },
          status: pendingStatus,
          updatedAt: now,
        },
        { merge: true },
      );
      tx.set(
        db.collection("users").doc(auth.uid).collection("assets").doc(normalizedAssetId),
        {
          deactivationReview: {
            requestId: normalizedRequestId,
            requestedAt: now,
            status: DEACTIVATION_REQUEST_STATUS.pending,
          },
          status: pendingStatus,
          updatedAt: now,
        },
        { merge: true },
      );

      result = {
        requestId: normalizedRequestId,
        status: DEACTIVATION_REQUEST_STATUS.pending,
        blockingBookingCount: blockingBookings.length,
        success: true,
      };
    });

    return result;
  } catch (error) {
    rethrowCallableError(error, "Unable to request listing deactivation review");
  }
}

async function reviewListingDeactivationRequest(request) {
  try {
    const auth = request.auth;
    const { adminNotes, decision, requestId } = request.data || {};
    if (!auth?.token?.admin) {
      throwAndLogHttpsError("permission-denied", "Only admins can review listing deactivation requests");
    }

    const normalizedRequestId = normalizeRequiredText(requestId, "requestId", 160);
    const normalizedDecision = decision === "approve" ? "approve" : decision === "reject" ? "reject" : null;
    if (!normalizedDecision) {
      throwAndLogHttpsError("invalid-argument", "Decision must be approve or reject");
    }

    if (normalizedDecision === "reject") {
      return rejectListingDeactivationRequest({
        adminId: auth.uid,
        adminName: auth.token?.name || auth.token?.email || auth.uid,
        adminNotes,
        requestId: normalizedRequestId,
      });
    }

    return approveListingDeactivationRequest({
      adminId: auth.uid,
      adminName: auth.token?.name || auth.token?.email || auth.uid,
      adminNotes,
      requestId: normalizedRequestId,
    });
  } catch (error) {
    rethrowCallableError(error, "Unable to review listing deactivation request");
  }
}

async function rejectListingDeactivationRequest({ adminId, adminName, adminNotes, requestId }) {
  const db = admin.firestore();
  const requestRef = db.collection("listingDeactivationRequests").doc(requestId);
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  let result = null;

  await db.runTransaction(async (tx) => {
    const requestSnap = await tx.get(requestRef);
    if (!requestSnap.exists) {
      throwAndLogHttpsError("not-found", "Deactivation request not found");
    }

    const requestData = requestSnap.data();
    assertPendingRequest(requestData);
    const assetRef = db.collection("assets").doc(requestData.assetId);
    const ownerMirrorRef = db.collection("users").doc(requestData.ownerId).collection("assets").doc(requestData.assetId);

    tx.set(
      requestRef,
      {
        adminNotes: normalizeOptionalText(adminNotes, 1000),
        reviewedAt: now,
        reviewedBy: adminId,
        reviewedByName: adminName,
        status: DEACTIVATION_REQUEST_STATUS.rejected,
        updatedAt: now,
      },
      { merge: true },
    );
    tx.set(
      assetRef,
      {
        deactivationReview: {
          requestId,
          reviewedAt: now,
          status: DEACTIVATION_REQUEST_STATUS.rejected,
        },
        updatedAt: now,
      },
      { merge: true },
    );
    tx.set(
      ownerMirrorRef,
      {
        deactivationReview: {
          requestId,
          reviewedAt: now,
          status: DEACTIVATION_REQUEST_STATUS.rejected,
        },
        updatedAt: now,
      },
      { merge: true },
    );

    result = { requestId, status: DEACTIVATION_REQUEST_STATUS.rejected, success: true };
  });

  return result;
}

async function approveListingDeactivationRequest({ adminId, adminName, adminNotes, requestId }) {
  const db = admin.firestore();
  const requestRef = db.collection("listingDeactivationRequests").doc(requestId);
  const requestSnap = await requestRef.get();
  if (!requestSnap.exists) {
    throwAndLogHttpsError("not-found", "Deactivation request not found");
  }

  const requestData = requestSnap.data();
  assertPendingRequest(requestData);
  const blockingBookings = await fetchFutureBlockingBookings({ assetId: requestData.assetId, db });
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();

  await db.runTransaction(async (tx) => {
    const latestRequestSnap = await tx.get(requestRef);
    if (!latestRequestSnap.exists) {
      throwAndLogHttpsError("not-found", "Deactivation request not found");
    }
    assertPendingRequest(latestRequestSnap.data());

    const lock = {
      adminNotes: normalizeOptionalText(adminNotes, 1000),
      approvedAt: now,
      approvedBy: adminId,
      locked: true,
      reason: latestRequestSnap.data().reason || null,
      requestId,
    };
    const listingUpdate = {
      deactivationLock: lock,
      deactivationReview: {
        requestId,
        reviewedAt: now,
        status: DEACTIVATION_REQUEST_STATUS.approved,
      },
      status: LISTING_STATUS.archived,
      suppressFromRecommendations: true,
      updatedAt: now,
    };

    tx.set(db.collection("assets").doc(requestData.assetId), listingUpdate, { merge: true });
    tx.set(
      db.collection("users").doc(requestData.ownerId).collection("assets").doc(requestData.assetId),
      listingUpdate,
      { merge: true },
    );
    tx.set(
      requestRef,
      {
        adminNotes: normalizeOptionalText(adminNotes, 1000),
        reviewedAt: now,
        reviewedBy: adminId,
        reviewedByName: adminName,
        status: DEACTIVATION_REQUEST_STATUS.approved,
        updatedAt: now,
      },
      { merge: true },
    );
    tx.set(db.collection("assets").doc(requestData.assetId).collection("audits").doc(), {
      createdAt: now,
      createdBy: { name: adminName, uid: adminId },
      notes: `Listing archived after deactivation request ${requestId}.`,
      type: "Archived",
    });
  });

  const bookingResults = [];
  for (const booking of blockingBookings) {
    const renterId = booking?.renter?.uid;
    if (!renterId) {
      bookingResults.push({ bookingId: booking.id, status: "skipped_missing_renter" });
      continue;
    }

    const notes = "Listing deactivation approved after verified damage or force majeure review.";
    try {
      const result = booking.status === BOOKING_STATUS.pending
        ? await _adminDeclineBookingWithoutRefund({
            adminId,
            assetId: requestData.assetId,
            bookingId: booking.id,
            notes,
            renterId,
          })
        : await _adminCancelBookingWithFullRefund({
            adminId,
            assetId: requestData.assetId,
            bookingId: booking.id,
            notes,
            renterId,
          });

      bookingResults.push({
        bookingId: booking.id,
        refundStatus: result.refundStatus || null,
        status: result.status || null,
        success: result.success !== false,
      });

      await notifyBookingUnavailable({
        adminId,
        assetId: requestData.assetId,
        booking,
        bookingId: booking.id,
        renterId,
      });
    } catch (error) {
      functions.logger.error("Unable to process booking during listing deactivation approval", {
        assetId: requestData.assetId,
        bookingId: booking.id,
        error: error?.message || error,
        requestId,
      });
      bookingResults.push({
        bookingId: booking.id,
        error: error?.message || "Unknown booking processing error",
        status: "failed",
        success: false,
      });
    }
  }

  await requestRef.set(
    {
      approvalResult: {
        bookingResults,
        cancelledBookingCount: bookingResults.filter((item) => item.status === BOOKING_STATUS.cancelled).length,
        declinedBookingCount: bookingResults.filter((item) => item.status === BOOKING_STATUS.declined).length,
        refundFailureCount: bookingResults.filter((item) => item.refundStatus === "failed").length,
      },
      updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    },
    { merge: true },
  );

  await notifyOwnerDeactivationApproved({ adminId, requestData });

  return {
    bookingResults,
    requestId,
    status: DEACTIVATION_REQUEST_STATUS.approved,
    success: true,
  };
}

function buildDeletionEligibilityResult(blockingBookings) {
  return {
    canDelete: blockingBookings.length === 0,
    blockingBookingCount: blockingBookings.length,
    blockingBookings: blockingBookings.map(mapBookingSummary),
    hasUpcomingBookings: blockingBookings.length > 0,
  };
}

function buildDeactivationRequestData({
  assetId,
  blockingBookings,
  evidenceUrls,
  listing,
  notes,
  now,
  ownerId,
  reason,
  requestId,
}) {
  return {
    id: requestId,
    assetId,
    bookingSummaries: blockingBookings.map(mapBookingSummary),
    bookingSummaryUpdatedAt: now,
    createdAt: now,
    evidenceUrls,
    listingSnapshot: mapListingSnapshot(listing),
    notes,
    ownerId,
    reason,
    status: DEACTIVATION_REQUEST_STATUS.pending,
    updatedAt: now,
  };
}

async function fetchFutureBlockingBookings({ assetId, db }) {
  const snapshot = await futureBlockingBookingsQuery({ assetId, db }).get();
  return filterFutureBlockingBookings(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
}

function futureBlockingBookingsQuery({ assetId, db }) {
  return db
    .collection("assets")
    .doc(assetId)
    .collection("bookings")
    .where("status", "in", FUTURE_BLOCKING_BOOKING_STATUSES);
}

function filterFutureBlockingBookings(bookings, now = new Date()) {
  const today = normalizeToDay(now);
  return bookings.filter((booking) => {
    if (!FUTURE_BLOCKING_BOOKING_STATUSES.includes(booking?.status)) return false;
    const endDate = parseFirestoreDate(booking?.endDate);
    return endDate instanceof Date && !Number.isNaN(endDate.getTime()) && normalizeToDay(endDate) >= today;
  });
}

function mapBookingSummary(booking) {
  return {
    bookingId: booking.id || null,
    renterId: booking?.renter?.uid || null,
    renterName:
      (typeof booking?.renter?.displayName === "string" &&
        booking.renter.displayName.trim()) ||
      [booking?.renter?.firstName, booking?.renter?.lastName].filter(Boolean).join(" ").trim() ||
      null,
    startDate: booking.startDate || null,
    endDate: booking.endDate || null,
    status: booking.status || null,
    totalPrice: Number(booking.totalPrice || booking.paymentFlow?.amount || 0) || 0,
    refundStatus: booking.paymentFlow?.refundStatus || null,
  };
}

function mapListingSnapshot(listing) {
  return {
    categoryId: listing.categoryId || null,
    categoryName: listing.categoryName || null,
    subcategoryId: listing.subcategoryId || null,
    subcategoryName: listing.subcategoryName || null,
    images: Array.isArray(listing.images) ? listing.images : [],
    owner: listing.owner || null,
    ownerId: listing.ownerId || listing.owner?.uid || null,
    showcase: Array.isArray(listing.showcase) ? listing.showcase : [],
    status: listing.status || null,
    title: listing.title || null,
  };
}

function assertSignedIn(auth) {
  if (!auth?.uid) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }
}

function assertListingOwner(uid, listing) {
  if (!uid || listing?.ownerId !== uid) {
    throwAndLogHttpsError("permission-denied", "Only the listing owner can perform this action");
  }
}

function assertListingNotLocked(listing) {
  if (listing?.deactivationLock?.locked === true || listing?.status === LISTING_STATUS.archived) {
    throwAndLogHttpsError("failed-precondition", "Listing is locked");
  }
}

function assertPendingRequest(requestData) {
  if (requestData?.status !== DEACTIVATION_REQUEST_STATUS.pending) {
    throwAndLogHttpsError("failed-precondition", "Deactivation request is not pending");
  }
}

function normalizeRequiredText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throwAndLogHttpsError("invalid-argument", `Missing ${label}`);
  }
  return value.trim().slice(0, maxLength);
}

function normalizeOptionalText(value, maxLength = 500) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : null;
}

function normalizeEvidenceUrls(value, ownerId, requestId) {
  if (!Array.isArray(value)) {
    throwAndLogHttpsError("invalid-argument", "Evidence photos are required");
  }
  const urls = value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim())
    .slice(0, MAX_EVIDENCE_URLS);

  if (urls.length === 0) {
    throwAndLogHttpsError("invalid-argument", "At least one evidence photo is required");
  }

  const allowedPrefix = `users/${ownerId}/listingDeactivationRequests/${requestId}/evidence/`;
  if (!urls.every((url) => url.startsWith(allowedPrefix) || url.startsWith("https://"))) {
    throwAndLogHttpsError("invalid-argument", "Evidence photos must belong to this deactivation request");
  }

  return urls;
}

async function notifyBookingUnavailable({ adminId, assetId, booking, bookingId, renterId }) {
  const hasRefund = booking.status !== BOOKING_STATUS.pending;
  await sendNotificationToUser({
    uid: renterId,
    title: "Listing unavailable",
    body: hasRefund
      ? "Your booking was cancelled because the listing is no longer available. Full refund handling has started."
      : "Your booking request was declined because the listing is no longer available.",
    imageUrl: firstListingImageUrl(booking?.asset),
    data: {
      type: "booking",
      assetId,
      bookingId,
      chatId: booking.chatId || null,
      senderId: adminId,
    },
  }).catch((error) => {
    console.warn(`[listingDeactivation] Failed to notify renter ${renterId}: ${error.message}`);
  });
}

async function notifyOwnerDeactivationApproved({ adminId, requestData }) {
  await sendNotificationToUser({
    uid: requestData.ownerId,
    title: "Listing deactivation approved",
    body: "Your listing was archived and upcoming bookings were cancelled without owner penalties.",
    imageUrl: firstListingImageUrl(requestData.listingSnapshot),
    data: {
      type: "listing_deactivation",
      assetId: requestData.assetId,
      requestId: requestData.id,
      senderId: adminId,
    },
  }).catch((error) => {
    console.warn(`[listingDeactivation] Failed to notify owner ${requestData.ownerId}: ${error.message}`);
  });
}

function rethrowCallableError(error, fallbackMessage) {
  if (error instanceof functions.https.HttpsError) {
    throw error;
  }
  functions.logger.error(fallbackMessage, error);
  throwAndLogHttpsError("internal", fallbackMessage);
}

module.exports = {
  deleteListing,
  getListingDeletionEligibility,
  requestListingDeactivationReview,
  reviewListingDeactivationRequest,
  _test: {
    DEACTIVATION_REQUEST_STATUS,
    FUTURE_BLOCKING_BOOKING_STATUSES,
    LISTING_STATUS,
    buildDeactivationRequestData,
    buildDeletionEligibilityResult,
    filterFutureBlockingBookings,
    mapBookingSummary,
    normalizeEvidenceUrls,
  },
};
