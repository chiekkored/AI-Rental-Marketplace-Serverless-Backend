const { throwAndLogHttpsError } = require("./error.util");

const PRESERVED_BLOCKED_CHAT_BOOKING_STATUSES = [
  "Pending",
  "Confirmed",
  "HandedOver",
  "Returned",
  "Cancellation Requested",
];

function userBlockId(blockerId, blockedUserId) {
  return `${blockerId.length}:${blockerId}${blockedUserId}`;
}

function userBlockRef(db, blockerId, blockedUserId) {
  return db.collection("userBlocks").doc(userBlockId(blockerId, blockedUserId));
}

function userBlockExclusionRef(db, uid, otherUid) {
  return db.collection("users").doc(uid).collection("blockExclusions").doc(otherUid);
}

async function blockedPairExists(db, firstUid, secondUid, transaction = null) {
  const refs = [userBlockRef(db, firstUid, secondUid), userBlockRef(db, secondUid, firstUid)];
  const snapshots = transaction ? await transaction.getAll(...refs) : await db.getAll(...refs);
  return snapshots.some((snapshot) => snapshot.exists);
}

async function loadExcludedUserIds(db, uid) {
  const snapshot = await db.collection("users").doc(uid).collection("blockExclusions").get();
  return new Set(snapshot.docs.map((doc) => doc.id));
}

async function assertUsersCanInteract(db, firstUid, secondUid, message = "You cannot interact with this user") {
  if (await blockedPairExists(db, firstUid, secondUid)) {
    throwAndLogHttpsError("failed-precondition", message);
  }
}

function shouldPreserveBlockedChat(chat = {}) {
  return (
    PRESERVED_BLOCKED_CHAT_BOOKING_STATUSES.includes(chat.bookingStatus) ||
    (Boolean(chat.bookingId) && !chat.bookingStatus)
  );
}

module.exports = {
  PRESERVED_BLOCKED_CHAT_BOOKING_STATUSES,
  assertUsersCanInteract,
  blockedPairExists,
  loadExcludedUserIds,
  shouldPreserveBlockedChat,
  userBlockExclusionRef,
  userBlockId,
  userBlockRef,
};
