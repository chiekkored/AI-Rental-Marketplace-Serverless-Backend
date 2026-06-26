const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");

const ACTION = {
  get: "get",
  create: "create",
  send: "send",
  close: "close",
  reopen: "reopen",
};

const CHAT_STATUS = {
  active: "Active",
  archived: "Archived",
};

const SUPPORT_CHAT_TYPE = "lend_support";
const LEGACY_SUPPORT_CHAT_TYPE = "Support";
const GENERAL_SUPPORT_CASE_TYPE = "general_user_support";

exports.manageUserSupportChat = async (request) => {
  try {
    const auth = request.auth;
    const data = request.data || {};

    assertAdmin(auth);

    const action = normalizeAction(data.action);
    const userId = normalizeRequiredText(data.userId, "user ID", 160);

    switch (action) {
      case ACTION.get:
        return getUserSupportChat({ userId });
      case ACTION.create:
        return createUserSupportChat({ userId });
      case ACTION.send:
        return sendUserSupportMessage({
          chatId: normalizeRequiredText(data.chatId, "chat ID", 160),
          text: normalizeMessageText(data.text),
          userId,
        });
      case ACTION.close:
        return updateUserSupportChatStatus({
          chatId: normalizeRequiredText(data.chatId, "chat ID", 160),
          status: CHAT_STATUS.archived,
          userId,
        });
      case ACTION.reopen:
        return updateUserSupportChatStatus({
          chatId: normalizeRequiredText(data.chatId, "chat ID", 160),
          status: CHAT_STATUS.active,
          userId,
        });
      default:
        throwAndLogHttpsError("invalid-argument", "Invalid support chat action");
    }
  } catch (error) {
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }

    functions.logger.error("Unexpected user support chat error", error);
    throwAndLogHttpsError("internal", "Unable to manage support chat");
  }
};

async function getUserSupportChat({ userId }) {
  const db = admin.firestore();
  const existing = await findExistingGeneralSupportChat({ db, userId });

  return {
    success: true,
    chat: existing ? mapSupportChatResult(existing) : null,
  };
}

async function createUserSupportChat({ userId }) {
  const db = admin.firestore();
  const userRef = db.collection("users").doc(userId);
  let result = null;

  await db.runTransaction(async (tx) => {
    const existing = await findExistingGeneralSupportChat({ db, tx, userId });
    if (existing) {
      result = mapSupportChatResult(existing);
      return;
    }

    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) {
      throwAndLogHttpsError("not-found", "User not found");
    }

    const supportUser = getSupportUserSnapshot();
    const participantUser = getParticipantUserSnapshot({
      id: userSnap.id,
      user: userSnap.data() || {},
    });
    const chatRef = db.collection("chats").doc();
    const messageRef = chatRef.collection("messages").doc();
    const supportChat = buildGeneralSupportChatWrite({
      chatId: chatRef.id,
      messageId: messageRef.id,
      now: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      participantUser,
      supportUser,
    });

    tx.set(chatRef, supportChat.root);
    tx.set(messageRef, supportChat.message);
    tx.set(db.collection("userChats").doc(userId), { isOnline: true }, { merge: true });
    tx.set(db.collection("userChats").doc(userId).collection("chats").doc(chatRef.id), supportChat.userChat);

    result = mapSupportChatResult({
      chatId: chatRef.id,
      root: supportChat.root,
      userChat: supportChat.userChat,
    });
  });

  return { success: true, chat: result };
}

async function sendUserSupportMessage({ chatId, text, userId }) {
  const db = admin.firestore();
  const chatRef = db.collection("chats").doc(chatId);
  const userChatRef = db.collection("userChats").doc(userId).collection("chats").doc(chatId);
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  const supportUser = getSupportUserSnapshot();
  let messageId = null;

  await db.runTransaction(async (tx) => {
    const [chatSnap, userChatSnap] = await Promise.all([tx.get(chatRef), tx.get(userChatRef)]);
    assertGeneralSupportChat({
      chat: chatSnap.exists ? chatSnap.data() : null,
      chatId,
      userChat: userChatSnap.exists ? userChatSnap.data() : null,
      userId,
    });

    if (userChatSnap.data()?.status === CHAT_STATUS.archived) {
      throwAndLogHttpsError("failed-precondition", "Support chat is closed");
    }

    const messageRef = chatRef.collection("messages").doc();
    messageId = messageRef.id;

    tx.set(messageRef, {
      id: messageRef.id,
      text,
      senderId: supportUser.uid,
      createdAt: now,
      type: "text",
      visibleTo: [userId, supportUser.uid],
    });
    tx.set(
      chatRef,
      {
        lastMessage: text,
        lastMessageDate: now,
        lastMessageSenderId: supportUser.uid,
        updatedAt: now,
      },
      { merge: true },
    );
    tx.set(
      userChatRef,
      {
        hasRead: false,
        lastMessage: text,
        lastMessageDate: now,
        lastMessageSenderId: supportUser.uid,
        lastUpdated: now,
      },
      { merge: true },
    );
  });

  return { success: true, chatId, messageId };
}

async function updateUserSupportChatStatus({ chatId, status, userId }) {
  const db = admin.firestore();
  const chatRef = db.collection("chats").doc(chatId);
  const userChatRef = db.collection("userChats").doc(userId).collection("chats").doc(chatId);
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();

  await db.runTransaction(async (tx) => {
    const [chatSnap, userChatSnap] = await Promise.all([tx.get(chatRef), tx.get(userChatRef)]);
    assertGeneralSupportChat({
      chat: chatSnap.exists ? chatSnap.data() : null,
      chatId,
      userChat: userChatSnap.exists ? userChatSnap.data() : null,
      userId,
    });

    tx.set(chatRef, { status, updatedAt: now }, { merge: true });
    tx.set(userChatRef, { status, lastUpdated: now }, { merge: true });
  });

  return { success: true, chatId, status };
}

async function findExistingGeneralSupportChat({ db, tx, userId }) {
  const query = db
    .collection("chats")
    .where("chatType", "in", [SUPPORT_CHAT_TYPE, LEGACY_SUPPORT_CHAT_TYPE])
    .where("supportCaseType", "==", GENERAL_SUPPORT_CASE_TYPE)
    .where("participantUserId", "==", userId)
    .limit(1);
  const snapshot = tx ? await tx.get(query) : await query.get();

  if (snapshot.empty) {
    return null;
  }

  const rootDoc = snapshot.docs[0];
  const chatId = rootDoc.id;
  const userChatRef = db.collection("userChats").doc(userId).collection("chats").doc(chatId);
  const userChatSnap = tx ? await tx.get(userChatRef) : await userChatRef.get();

  return {
    chatId,
    root: rootDoc.data() || {},
    userChat: userChatSnap.exists ? userChatSnap.data() || {} : null,
  };
}

function buildGeneralSupportChatWrite({ chatId, messageId, now, participantUser, supportUser }) {
  const messageText = "Lend Support opened this conversation.";

  return {
    root: {
      id: chatId,
      chatId,
      chatType: SUPPORT_CHAT_TYPE,
      supportCaseType: GENERAL_SUPPORT_CASE_TYPE,
      participantUserId: participantUser.uid,
      supportUserId: supportUser.uid,
      createdAt: now,
      updatedAt: now,
      status: CHAT_STATUS.active,
      lastMessage: messageText,
      lastMessageDate: now,
      lastMessageSenderId: "",
    },
    message: {
      id: messageId,
      text: messageText,
      senderId: "",
      createdAt: now,
      type: "system",
      visibleTo: [participantUser.uid, supportUser.uid],
    },
    userChat: {
      id: chatId,
      chatId,
      participants: [supportUser, participantUser],
      lastMessage: messageText,
      lastMessageDate: now,
      lastMessageSenderId: "",
      createdAt: now,
      hasRead: false,
      status: CHAT_STATUS.active,
      chatType: SUPPORT_CHAT_TYPE,
      supportCaseType: GENERAL_SUPPORT_CASE_TYPE,
    },
  };
}

function assertAdmin(auth) {
  if (!auth?.token?.admin) {
    throwAndLogHttpsError("permission-denied", "Only admins can manage support chats");
  }
}

function assertGeneralSupportChat({ chat, chatId, userChat, userId }) {
  if (!chat || !userChat) {
    throwAndLogHttpsError("not-found", "Support chat not found");
  }

  if (
    ![SUPPORT_CHAT_TYPE, LEGACY_SUPPORT_CHAT_TYPE].includes(chat.chatType) ||
    chat.supportCaseType !== GENERAL_SUPPORT_CASE_TYPE ||
    chat.participantUserId !== userId ||
    userChat.chatId !== chatId
  ) {
    throwAndLogHttpsError("permission-denied", "Support chat does not match this user");
  }
}

function getParticipantUserSnapshot({ id, user }) {
  const displayName = resolveMarketplaceDisplayName(user);
  return {
    uid: user.uid || id,
    firstName: normalizeNullableText(user.firstName),
    lastName: normalizeNullableText(user.lastName),
    ...(normalizeNullableText(displayName)
      ? { displayName: normalizeNullableText(displayName) }
      : {}),
    photoUrl: normalizeNullableText(user.photoUrl),
    verified: normalizeNullableText(user.verified) || "None",
    userMetadataVersion: Number.isFinite(user.userMetadataVersion) ? user.userMetadataVersion : 1,
  };
}

function getSupportUserSnapshot() {
  return {
    uid: process.env.LEND_SUPPORT_USER_ID || "lend_support",
    firstName: "Lend Support",
    lastName: "",
    photoUrl: process.env.LEND_SUPPORT_PHOTO_URL || null,
    verified: "Full",
    userMetadataVersion: 1,
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

function mapSupportChatResult(existing) {
  const root = existing.root || {};
  const userChat = existing.userChat || {};

  return {
    chatId: existing.chatId,
    createdAt: root.createdAt || userChat.createdAt || null,
    lastMessage: userChat.lastMessage || root.lastMessage || null,
    lastMessageDate: userChat.lastMessageDate || root.lastMessageDate || null,
    status: userChat.status || root.status || CHAT_STATUS.active,
  };
}

function normalizeAction(value) {
  if (Object.values(ACTION).includes(value)) {
    return value;
  }

  throwAndLogHttpsError("invalid-argument", "Invalid support chat action");
}

function normalizeRequiredText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throwAndLogHttpsError("invalid-argument", `Missing ${label}`);
  }

  return value.trim().slice(0, maxLength);
}

function normalizeNullableText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeMessageText(value) {
  const text = normalizeRequiredText(value, "message", 2000);
  if (!text) {
    throwAndLogHttpsError("invalid-argument", "Missing message");
  }

  return text;
}

exports._test = {
  ACTION,
  CHAT_STATUS,
  GENERAL_SUPPORT_CASE_TYPE,
  LEGACY_SUPPORT_CHAT_TYPE,
  SUPPORT_CHAT_TYPE,
  assertGeneralSupportChat,
  buildGeneralSupportChatWrite,
  getParticipantUserSnapshot,
  getSupportUserSnapshot,
  mapSupportChatResult,
  normalizeAction,
  normalizeMessageText,
};
