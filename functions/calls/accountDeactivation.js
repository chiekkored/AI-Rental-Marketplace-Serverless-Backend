const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { saveAccountFeedback } = require("../utils/accountFeedback.util");
const { throwAndLogHttpsError } = require("../utils/error.util");

const USER_STATUS = {
  active: "Active",
  deactivated: "Deactivated",
  deleted: "Deleted",
  disabled: "Disabled",
};

const LISTING_STATUS = {
  archived: "Archived",
  hidden: "Hidden",
};

const BLOCKING_BOOKING_STATUSES = [
  "Pending",
  "Confirmed",
  "HandedOver",
  "Returned",
  "Cancellation Requested",
];

const BLOCKING_CHECKOUT_STATUSES = [
  "initialized",
  "processing",
  "subscription_pending",
];

const BLOCKING_MOVEMENT_STATUSES = [
  "pending",
  "processing",
  "failed",
  "configuration_required",
  "missing_destination",
];

const OPEN_REPORT_STATUSES = ["Open", "Pending"];
const PENDING_REVIEW_STATUS = "Pending";

async function getAccountDeactivationEligibility(request) {
  try {
    const auth = requireSignedIn(request.auth);
    const uid = normalizeUid(request.data?.uid || auth.uid);
    assertSelfOrAdmin(auth, uid, "check this account");

    return buildEligibilityResponse(await collectAccountDeactivationBlockers({ uid }));
  } catch (error) {
    rethrowCallableError(error, "Unable to check account deactivation eligibility");
  }
}

async function deactivateAccount(request) {
  try {
    const auth = requireSignedIn(request.auth);
    const uid = normalizeUid(request.data?.uid || auth.uid);
    assertSelf(auth, uid, "deactivate this account");

    const blockers = await collectAccountDeactivationBlockers({ uid });
    const eligibility = buildEligibilityResponse(blockers);
    if (!eligibility.canDeactivate) {
      return {
        success: false,
        ...eligibility,
        message: "Resolve pending obligations before deactivating your account.",
      };
    }

    const db = admin.firestore();
    await saveAccountFeedback(request.data?.feedback, "deactivate", db);

    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
    await db.collection("users").doc(uid).set(
      {
        status: USER_STATUS.deactivated,
        deactivatedAt: now,
        deactivation: {
          active: true,
          deactivatedAt: now,
          requestedBy: uid,
        },
        userMetadataVersion: admin.firestore.FieldValue?.increment?.(1) || admin.firestore.FieldValue.increment(1),
      },
      { merge: true },
    );

    const listingResult = await hideListingsForAccountDeactivation({ db, now, uid });
    const chatResult = await updateChatParticipantSnapshots({
      db,
      uid,
      participantSnapshot: buildDeactivatedParticipantSnapshot(uid),
    });

    return {
      success: true,
      uid,
      status: USER_STATUS.deactivated,
      hiddenListingCount: listingResult.hiddenListingCount,
      skippedListingCount: listingResult.skippedListingCount,
      updatedChatCount: chatResult.updatedChatCount,
    };
  } catch (error) {
    rethrowCallableError(error, "Unable to deactivate account");
  }
}

async function reactivateAccount(request) {
  try {
    const auth = requireSignedIn(request.auth);
    const uid = normalizeUid(request.data?.uid || auth.uid);
    assertSelf(auth, uid, "reactivate this account");

    const db = admin.firestore();
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throwAndLogHttpsError("not-found", "Account not found");
    }

    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
    await userRef.set(
      {
        status: USER_STATUS.active,
        reactivatedAt: now,
        deactivation: {
          active: false,
          reactivatedAt: now,
        },
        userMetadataVersion: admin.firestore.FieldValue?.increment?.(1) || admin.firestore.FieldValue.increment(1),
      },
      { merge: true },
    );

    const restoreResult = await restoreListingsAfterAccountReactivation({ db, now, uid });
    const chatResult = await updateChatParticipantSnapshots({
      db,
      uid,
      participantSnapshot: buildActiveParticipantSnapshot(uid, {
        ...userSnap.data(),
        status: USER_STATUS.active,
      }),
    });

    return {
      success: true,
      uid,
      status: USER_STATUS.active,
      restoredListingCount: restoreResult.restoredListingCount,
      skippedListingCount: restoreResult.skippedListingCount,
      updatedChatCount: chatResult.updatedChatCount,
    };
  } catch (error) {
    rethrowCallableError(error, "Unable to reactivate account");
  }
}

async function assertUserCanReceiveNewBooking(db, uid) {
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) {
    throwAndLogHttpsError("failed-precondition", "Asset owner account is unavailable");
  }
  if (
    snap.data()?.status === USER_STATUS.deactivated ||
    snap.data()?.status === USER_STATUS.deleted ||
    snap.data()?.status === USER_STATUS.disabled
  ) {
    throwAndLogHttpsError("failed-precondition", "This owner is not accepting new bookings");
  }
}

async function collectAccountDeactivationBlockers({ uid }) {
  const db = admin.firestore();
  const [
    renterBookings,
    ownerBookings,
    renterCheckouts,
    ownerCheckouts,
    targetMovements,
    ownerMovements,
    renterMovements,
    outstandingBookings,
    reporterReports,
    reportedReports,
    listingRequests,
    userSnap,
  ] = await Promise.all([
    queryDocs(db.collection("bookings").where("renter.uid", "==", uid).where("status", "in", BLOCKING_BOOKING_STATUSES)),
    queryDocs(db.collection("bookings").where("asset.owner.uid", "==", uid).where("status", "in", BLOCKING_BOOKING_STATUSES)),
    queryDocs(db.collection("paymentCheckouts").where("renterId", "==", uid).where("status", "in", BLOCKING_CHECKOUT_STATUSES)),
    queryDocs(db.collection("paymentCheckouts").where("ownerId", "==", uid).where("status", "in", BLOCKING_CHECKOUT_STATUSES)),
    queryDocs(db.collection("bookingPayouts").where("targetUserId", "==", uid).where("status", "in", BLOCKING_MOVEMENT_STATUSES)),
    queryDocs(db.collection("bookingPayouts").where("ownerId", "==", uid).where("status", "in", BLOCKING_MOVEMENT_STATUSES)),
    queryDocs(db.collection("bookingPayouts").where("renterId", "==", uid).where("status", "in", BLOCKING_MOVEMENT_STATUSES)),
    queryDocs(db.collection("users").doc(uid).collection("bookings").where("settlement.outstandingDamageAmount", ">", 0)),
    queryDocs(db.collection("reports").where("reporterId", "==", uid)),
    queryDocs(db.collection("reports").where("reportedUserId", "==", uid)),
    queryDocs(db.collection("listingDeactivationRequests").where("ownerId", "==", uid).where("status", "==", PENDING_REVIEW_STATUS)),
    db.collection("users").doc(uid).get(),
  ]);

  const pendingReviews = [];
  const user = userSnap.data() || {};
  if (user?.fullVerification?.status === PENDING_REVIEW_STATUS) {
    pendingReviews.push({ id: "fullVerification", type: "Full verification review" });
  }
  if (user?.businessRegistration?.status === "Submitted") {
    pendingReviews.push({ id: "businessRegistration", type: "Business registration review" });
  }

  const activeReports = [...reporterReports, ...reportedReports].filter((item) => OPEN_REPORT_STATUSES.includes(item.status));
  const activeBookingRows = uniqueById([...renterBookings, ...ownerBookings]);
  const checkoutRows = uniqueById([...renterCheckouts, ...ownerCheckouts]);
  const movementRows = uniqueById([...targetMovements, ...ownerMovements, ...renterMovements]);
  const disputeRows = uniqueById(
    [...activeBookingRows, ...outstandingBookings].filter(hasUnresolvedDispute),
  );

  return {
    activeBookings: activeBookingRows.map(mapBookingBlocker),
    paymentCheckouts: checkoutRows.map(mapPaymentCheckoutBlocker),
    moneyMovements: movementRows.map(mapMoneyMovementBlocker),
    outstandingBalances: outstandingBookings.filter(hasOutstandingBalance).map(mapOutstandingBalanceBlocker),
    disputes: disputeRows.map(mapDisputeBlocker),
    reports: activeReports.map(mapReportBlocker),
    listingReviews: listingRequests.map((item) => ({
      id: item.id,
      title: item.listingSnapshot?.title || item.assetId || "Listing review",
      status: item.status || null,
      type: "Pending listing deactivation review",
    })),
    pendingReviews,
  };
}

async function hideListingsForAccountDeactivation({ db, now, uid }) {
  const snap = await db.collection("assets").where("ownerId", "==", uid).get();
  const writer = db.bulkWriter();
  let hiddenListingCount = 0;
  let skippedListingCount = 0;

  for (const doc of snap.docs) {
    const listing = doc.data();
    if (listing.isDeleted === true || listing.status === LISTING_STATUS.archived) {
      skippedListingCount += 1;
      continue;
    }

    const update = buildListingDeactivationUpdate(listing, now);
    writer.set(doc.ref, update, { merge: true });
    writer.set(db.collection("users").doc(uid).collection("assets").doc(doc.id), update, { merge: true });
    hiddenListingCount += 1;
  }

  await writer.close();
  return { hiddenListingCount, skippedListingCount };
}

async function restoreListingsAfterAccountReactivation({ db, now, uid }) {
  const snap = await db.collection("assets").where("ownerId", "==", uid).get();
  const writer = db.bulkWriter();
  let restoredListingCount = 0;
  let skippedListingCount = 0;

  for (const doc of snap.docs) {
    const listing = doc.data();
    const deactivation = listing.accountDeactivation || {};
    if (listing.isDeleted === true || listing.status === LISTING_STATUS.archived || deactivation.active !== true) {
      skippedListingCount += 1;
      continue;
    }

    const update = buildListingReactivationUpdate(listing, now);
    writer.set(doc.ref, update, { merge: true });
    writer.set(db.collection("users").doc(uid).collection("assets").doc(doc.id), update, { merge: true });
    restoredListingCount += 1;
  }

  await writer.close();
  return { restoredListingCount, skippedListingCount };
}

function buildListingDeactivationUpdate(listing, now) {
  const previousStatus = listing.accountDeactivation?.previousStatus || listing.status || null;
  return {
    status: LISTING_STATUS.hidden,
    suppressFromRecommendations: true,
    accountDeactivation: {
      active: true,
      deactivatedAt: now,
      previousStatus,
      previousSuppressFromRecommendations: listing.suppressFromRecommendations === true,
    },
    updatedAt: now,
  };
}

function buildListingReactivationUpdate(listing, now) {
  const deactivation = listing.accountDeactivation || {};
  const nextStatus =
    typeof deactivation.previousStatus === "string" && deactivation.previousStatus.trim()
      ? deactivation.previousStatus
      : LISTING_STATUS.hidden;
  const hasStoredSuppression = typeof deactivation.previousSuppressFromRecommendations === "boolean";

  return {
    status: nextStatus,
    suppressFromRecommendations: hasStoredSuppression
      ? deactivation.previousSuppressFromRecommendations
      : nextStatus !== "Available" ? listing.suppressFromRecommendations === true : false,
    accountDeactivation: {
      ...deactivation,
      active: false,
      reactivatedAt: now,
    },
    updatedAt: now,
  };
}

async function updateChatParticipantSnapshots({ db, uid, participantSnapshot }) {
  const snap = await db.collectionGroup("chats").where("participantIds", "array-contains", uid).get();
  const writer = db.bulkWriter();
  let updatedChatCount = 0;

  for (const doc of snap.docs) {
    const chat = doc.data();
    if (!Array.isArray(chat.participants)) continue;

    const participants = chat.participants.map((participant) =>
      participant?.uid === uid ? { ...participantSnapshot } : participant,
    );
    writer.set(doc.ref, { participants }, { merge: true });
    updatedChatCount += 1;
  }

  await writer.close();
  return { updatedChatCount };
}

function buildDeactivatedParticipantSnapshot(uid) {
  return {
    uid,
    firstName: null,
    lastName: null,
    displayName: null,
    photoUrl: null,
    verified: "None",
    status: USER_STATUS.deactivated,
    isFoundingOwner: false,
    userMetadataVersion: 1,
  };
}

function buildActiveParticipantSnapshot(uid, user) {
  return {
    uid,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    displayName: user.displayName || null,
    photoUrl: user.photoUrl || null,
    verified: user.verified || "None",
    status: USER_STATUS.active,
    isFoundingOwner: user.isFoundingOwner === true || user.foundingOwner != null || user.foundingOwnerInvite != null,
    userMetadataVersion: Number(user.userMetadataVersion || 1) + 1,
  };
}

function buildEligibilityResponse(blockers) {
  const categories = Object.entries(blockers).map(([key, items]) => ({
    key,
    count: Array.isArray(items) ? items.length : 0,
    items: Array.isArray(items) ? items.slice(0, 10) : [],
  }));
  const blockerCount = categories.reduce((total, item) => total + item.count, 0);
  return {
    canDeactivate: blockerCount === 0,
    blockerCount,
    blockers: categories.filter((item) => item.count > 0),
  };
}

async function queryDocs(query) {
  const snap = await query.get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function hasOutstandingBalance(booking) {
  return Number(booking?.settlement?.outstandingDamageAmount || 0) > 0;
}

function hasUnresolvedDispute(booking) {
  const dispute = booking?.disputeFlow || {};
  const deposit = booking?.depositFlow || {};
  const statuses = [
    dispute.status,
    dispute.supportStatus,
    deposit.status,
    booking?.damageDeductionRequest?.status,
    booking?.settlement?.status,
  ]
    .filter(Boolean)
    .map((status) => String(status).toLowerCase());

  return statuses.some((status) =>
    [
      "requested",
      "disputed",
      "support_review",
      "support_pending",
      "admin_review_required",
      "outstanding_payment_pending",
      "awaiting_renter_response",
    ].includes(status),
  );
}

function mapBookingBlocker(booking) {
  return {
    id: booking.id,
    assetTitle: booking.asset?.title || booking.assetTitle || null,
    role: booking.renter?.uid && booking.asset?.owner?.uid
      ? null
      : null,
    status: booking.status || null,
    startDate: booking.startDate || null,
    endDate: booking.endDate || null,
    type: "Pending or active booking",
  };
}

function mapPaymentCheckoutBlocker(checkout) {
  return {
    id: checkout.id,
    assetId: checkout.assetId || null,
    status: checkout.status || null,
    type: "Pending payment checkout",
  };
}

function mapMoneyMovementBlocker(movement) {
  return {
    id: movement.id,
    amount: movement.amount || null,
    currency: movement.currency || null,
    status: movement.status || null,
    type: "Pending money movement",
  };
}

function mapOutstandingBalanceBlocker(booking) {
  return {
    id: booking.id,
    amount: Number(booking?.settlement?.outstandingDamageAmount || 0),
    currency: booking?.settlement?.currency || booking?.paymentFlow?.currency || null,
    type: "Outstanding damage balance",
  };
}

function mapDisputeBlocker(booking) {
  return {
    id: booking.id,
    assetTitle: booking.asset?.title || null,
    status: booking?.disputeFlow?.status || booking?.depositFlow?.status || null,
    type: "Unresolved dispute or settlement review",
  };
}

function mapReportBlocker(report) {
  return {
    id: report.id,
    status: report.status || null,
    type: "Open report",
  };
}

function requireSignedIn(auth) {
  if (!auth?.uid) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }
  return auth;
}

function normalizeUid(value) {
  const uid = typeof value === "string" ? value.trim() : "";
  if (!uid) {
    throwAndLogHttpsError("invalid-argument", "Missing uid");
  }
  return uid;
}

function assertSelf(auth, uid, action) {
  if (auth.uid !== uid) {
    throwAndLogHttpsError("permission-denied", `You are not allowed to ${action}`);
  }
}

function assertSelfOrAdmin(auth, uid, action) {
  if (auth.uid !== uid && auth.token?.admin !== true) {
    throwAndLogHttpsError("permission-denied", `You are not allowed to ${action}`);
  }
}

function rethrowCallableError(error, fallbackMessage) {
  if (error instanceof functions.https.HttpsError) {
    throw error;
  }
  functions.logger.error(fallbackMessage, error);
  throwAndLogHttpsError("internal", fallbackMessage);
}

module.exports = {
  USER_STATUS,
  assertUserCanReceiveNewBooking,
  buildEligibilityResponse,
  collectAccountDeactivationBlockers,
  deactivateAccount,
  getAccountDeactivationEligibility,
  reactivateAccount,
  _test: {
    BLOCKING_BOOKING_STATUSES,
    BLOCKING_CHECKOUT_STATUSES,
    BLOCKING_MOVEMENT_STATUSES,
    buildListingDeactivationUpdate,
    buildListingReactivationUpdate,
    buildEligibilityResponse,
    hasOutstandingBalance,
    hasUnresolvedDispute,
    uniqueById,
  },
};
