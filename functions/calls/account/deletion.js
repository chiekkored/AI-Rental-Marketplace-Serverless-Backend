const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { saveAccountFeedback } = require("../../utils/accountFeedback.util");
const { throwAndLogHttpsError } = require("../../utils/error.util");
const {
  buildEligibilityResponse,
  collectAccountDeactivationBlockers,
} = require("../accountDeactivation");

const USER_STATUS = {
  deleted: "Deleted",
};

const LISTING_STATUS = {
  archived: "Archived",
  hidden: "Hidden",
};

async function getAccountDeletionEligibility(request) {
  try {
    const auth = requireSignedIn(request.auth);
    const uid = normalizeUid(request.data?.uid || auth.uid);
    assertSelfOrAdmin(auth, uid, "check this account");

    return buildEligibilityResponse(await collectAccountDeactivationBlockers({ uid }));
  } catch (error) {
    rethrowCallableError(error, "Unable to check account deletion eligibility");
  }
}

async function deleteUserAccount(request) {
  try {
    const auth = requireSignedIn(request.auth);
    const data = request.data || {};
    const uid = normalizeUid(data.uid || auth.uid);
    const isSelf = auth.uid === uid;
    const isAdmin = auth.token?.admin === true;

    if (!isSelf && !isAdmin) {
      throwAndLogHttpsError("permission-denied", "You are not allowed to delete this account");
    }

    if (isAdmin && isSelf) {
      throwAndLogHttpsError("failed-precondition", "Admins cannot delete themselves");
    }

    const db = admin.firestore();
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throwAndLogHttpsError("not-found", "Account not found");
    }

    const blockers = await collectAccountDeactivationBlockers({ uid });
    const eligibility = buildEligibilityResponse(blockers);
    if (!eligibility.canDeactivate) {
      return {
        success: false,
        ...eligibility,
        message: "Resolve pending obligations before deleting your account.",
      };
    }

    if (isSelf) {
      await saveAccountFeedback(data.feedback, "delete", db);
    }

    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();

    await revokeAndDeleteAuthAccount(uid);
    await userRef.set(buildDeletedUserUpdate(userSnap.data() || {}, now, auth.uid), { merge: true });

    const [assetResult, chatResult, mirrorResult] = await Promise.all([
      closeOwnedListingsForAccountDeletion({ db, now, uid }),
      anonymizeChatParticipantSnapshots({ db, uid, participantSnapshot: buildDeletedParticipantSnapshot(uid) }),
      removePrivateAccountMirrors({ db, uid }),
    ]);

    return {
      success: true,
      uid,
      status: USER_STATUS.deleted,
      deletedListingCount: assetResult.deletedListingCount,
      skippedListingCount: assetResult.skippedListingCount,
      updatedChatCount: chatResult.updatedChatCount,
      removedMirrorCount: mirrorResult.removedMirrorCount,
    };
  } catch (error) {
    rethrowCallableError(error, "Unable to delete account");
  }
}

async function closeOwnedListingsForAccountDeletion({ db, now, uid }) {
  const snap = await db.collection("assets").where("ownerId", "==", uid).get();
  const writer = db.bulkWriter();
  let deletedListingCount = 0;
  let skippedListingCount = 0;

  for (const doc of snap.docs) {
    const listing = doc.data();
    if (listing.isDeleted === true && listing.accountDeletion?.active === true) {
      skippedListingCount += 1;
      continue;
    }

    const update = buildDeletedListingUpdate(listing, now);
    writer.set(doc.ref, update, { merge: true });
    writer.set(db.collection("users").doc(uid).collection("assets").doc(doc.id), update, { merge: true });
    deletedListingCount += 1;
  }

  await writer.close();
  return { deletedListingCount, skippedListingCount };
}

async function anonymizeChatParticipantSnapshots({ db, uid, participantSnapshot }) {
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

async function removePrivateAccountMirrors({ db, uid }) {
  const writer = db.bulkWriter();
  let removedMirrorCount = 0;

  const collections = [
    db.collection("users").doc(uid).collection("saved"),
    db.collection("users").doc(uid).collection("notifications"),
    db.collection("users").doc(uid).collection("blockExclusions"),
    db.collection("userChats").doc(uid).collection("chats"),
  ];

  for (const collection of collections) {
    const snap = await collection.get();
    for (const doc of snap.docs) {
      writer.delete(doc.ref);
      removedMirrorCount += 1;
    }
  }

  writer.set(db.collection("userChats").doc(uid), {
    isOnline: false,
    status: USER_STATUS.deleted,
    updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
  }, { merge: true });

  await writer.close();
  return { removedMirrorCount };
}

function buildDeletedUserUpdate(user, now, requestedBy) {
  return {
    uid: user.uid || null,
    firstName: null,
    lastName: null,
    displayName: null,
    photoUrl: null,
    verified: "None",
    status: USER_STATUS.deleted,
    deletedAt: now,
    deletion: {
      active: true,
      deletedAt: now,
      requestedBy,
    },
    deactivation: {
      active: false,
      reactivatedAt: null,
    },
    userMetadataVersion: admin.firestore.FieldValue?.increment?.(1) || admin.firestore.FieldValue.increment(1),
  };
}

function buildDeletedListingUpdate(listing, now) {
  const previousStatus =
    listing.accountDeletion?.previousStatus ||
    listing.accountDeactivation?.previousStatus ||
    listing.status ||
    null;

  return {
    isDeleted: true,
    status: LISTING_STATUS.archived,
    suppressFromRecommendations: true,
    accountDeletion: {
      active: true,
      deletedAt: now,
      previousStatus,
      previousSuppressFromRecommendations: listing.suppressFromRecommendations === true,
    },
    updatedAt: now,
  };
}

function buildDeletedParticipantSnapshot(uid) {
  return {
    uid,
    firstName: null,
    lastName: null,
    displayName: null,
    photoUrl: null,
    verified: "None",
    status: USER_STATUS.deleted,
    isFoundingOwner: false,
    userMetadataVersion: 1,
  };
}

async function revokeAndDeleteAuthAccount(uid) {
  try {
    await admin.auth().revokeRefreshTokens(uid);
  } catch (error) {
    if (!isMissingAuthUser(error)) {
      throw error;
    }
  }

  try {
    await admin.auth().deleteUser(uid);
  } catch (error) {
    if (!isMissingAuthUser(error)) {
      throw error;
    }
  }
}

function isMissingAuthUser(error) {
  return error?.code === "auth/user-not-found" || error?.errorInfo?.code === "auth/user-not-found";
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
  getAccountDeletionEligibility,
  deleteUserAccount,
  _test: {
    buildDeletedListingUpdate,
    buildDeletedParticipantSnapshot,
    buildDeletedUserUpdate,
    closeOwnedListingsForAccountDeletion,
    anonymizeChatParticipantSnapshots,
    removePrivateAccountMirrors,
    revokeAndDeleteAuthAccount,
  },
};
