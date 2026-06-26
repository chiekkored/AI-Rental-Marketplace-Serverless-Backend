const admin = require("firebase-admin");
const functions = require("firebase-functions");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  shouldPreserveBlockedChat,
  userBlockExclusionRef,
  userBlockRef,
} = require("../utils/userBlock.util");

const ACTIONS = {
  block: "block",
  unblock: "unblock",
  list: "list",
};

exports.manageUserBlock = async (request) => {
  try {
    const uid = request.auth?.uid;
    const action = String(request.data?.action || "").trim();

    if (!uid) {
      throwAndLogHttpsError("permission-denied", "User must be authenticated");
    }
    if (!Object.values(ACTIONS).includes(action)) {
      throwAndLogHttpsError("invalid-argument", "Invalid block action");
    }

    if (action === ACTIONS.list) {
      return listBlockedUsers(uid);
    }

    const targetUserId = String(request.data?.targetUserId || "").trim();
    assertValidTarget(uid, targetUserId);

    if (action === ACTIONS.block) {
      return blockUser(uid, targetUserId);
    }
    return unblockUser(uid, targetUserId);
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    functions.logger.error("[manageUserBlock] Unexpected error", error);
    throwAndLogHttpsError("internal", "Unable to manage blocked user");
  }
};

async function blockUser(blockerId, blockedUserId) {
  const db = admin.firestore();
  const blockedSnap = await db.collection("users").doc(blockedUserId).get();
  if (!blockedSnap.exists) {
    throwAndLogHttpsError("not-found", "User not found");
  }
  if (blockedUserId === "lend_support" || blockedSnap.data()?.type === "support") {
    throwAndLogHttpsError("failed-precondition", "Lend Support cannot be blocked");
  }

  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  const batch = db.batch();
  batch.set(userBlockRef(db, blockerId, blockedUserId), {
    blockerId,
    blockedUserId,
    blockedUser: simpleUser(blockedSnap.data(), blockedUserId),
    createdAt: now,
  }, { merge: true });
  batch.set(userBlockExclusionRef(db, blockerId, blockedUserId), {
    otherUid: blockedUserId,
    updatedAt: now,
  }, { merge: true });
  batch.set(userBlockExclusionRef(db, blockedUserId, blockerId), {
    otherUid: blockerId,
    updatedAt: now,
  }, { merge: true });
  await batch.commit();

  try {
    await cleanupBlockedPair(db, blockerId, blockedUserId, now);
  } catch (error) {
    functions.logger.error("[manageUserBlock] Block cleanup failed", {
      blockerId,
      blockedUserId,
      error,
    });
  }
  return {
    success: true,
    blockedUser: simpleUser(blockedSnap.data(), blockedUserId),
  };
}

async function cleanupBlockedPair(db, blockerId, blockedUserId, now) {
  const [blockerSaved, blockedSaved, blockerChats] = await Promise.all([
    db.collection("users").doc(blockerId).collection("saved").where("owner.uid", "==", blockedUserId).get(),
    db.collection("users").doc(blockedUserId).collection("saved").where("owner.uid", "==", blockerId).get(),
    db.collection("userChats").doc(blockerId).collection("chats")
      .where("participantIds", "array-contains", blockedUserId).get(),
  ]);
  const writes = [
    ...blockerSaved.docs.map((doc) => (batch) => batch.delete(doc.ref)),
    ...blockedSaved.docs.map((doc) => (batch) => batch.delete(doc.ref)),
  ];
  blockerChats.docs.forEach((doc) => {
    if (shouldPreserveBlockedChat(doc.data())) return;
    writes.push((batch) => batch.set(doc.ref, { status: "Archived", lastUpdated: now }, { merge: true }));
    writes.push((batch) => batch.set(
      db.collection("userChats").doc(blockedUserId).collection("chats").doc(doc.id),
      { status: "Archived", lastUpdated: now },
      { merge: true },
    ));
  });
  await commitWritesInChunks(db, writes);
}

async function commitWritesInChunks(db, writes, chunkSize = 400) {
  for (let index = 0; index < writes.length; index += chunkSize) {
    const batch = db.batch();
    writes.slice(index, index + chunkSize).forEach((write) => write(batch));
    await batch.commit();
  }
}

async function unblockUser(blockerId, blockedUserId) {
  const db = admin.firestore();
  const reverseExists = (await userBlockRef(db, blockedUserId, blockerId).get()).exists;
  const batch = db.batch();
  batch.delete(userBlockRef(db, blockerId, blockedUserId));
  if (!reverseExists) {
    batch.delete(userBlockExclusionRef(db, blockerId, blockedUserId));
    batch.delete(userBlockExclusionRef(db, blockedUserId, blockerId));
  }
  await batch.commit();
  return { success: true };
}

async function listBlockedUsers(uid) {
  const snapshot = await admin.firestore().collection("userBlocks").where("blockerId", "==", uid).get();
  return {
    users: snapshot.docs
      .map((doc) => doc.data()?.blockedUser)
      .filter(Boolean),
  };
}

function assertValidTarget(uid, targetUserId) {
  if (!targetUserId) {
    throwAndLogHttpsError("invalid-argument", "Missing target user");
  }
  if (uid === targetUserId) {
    throwAndLogHttpsError("failed-precondition", "You cannot block yourself");
  }
}

function simpleUser(user = {}, uid) {
  const displayName = resolveMarketplaceDisplayName(user);
  return {
    uid,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    displayName,
    photoUrl: user.photoUrl || null,
    verified: user.verified || "None",
    userMetadataVersion: user.userMetadataVersion || 1,
  };
}

function resolveMarketplaceDisplayName(user) {
  const businessName = typeof user?.businessRegistration?.businessName === "string"
    ? user.businessRegistration.businessName.trim()
    : "";
  const businessApproved = user?.businessRegistration?.status === "Approved";
  return user?.useBusinessNameForListingOwnerName === true && businessApproved && businessName
    ? businessName
    : null;
}

exports._test = {
  ACTIONS,
  assertValidTarget,
  commitWritesInChunks,
  simpleUser,
};
