const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _test: {
    CHAT_STATUS,
    GENERAL_SUPPORT_CASE_TYPE,
    assertGeneralSupportChat,
    buildGeneralSupportChatWrite,
    getParticipantUserSnapshot,
    getSupportUserSnapshot,
    LEGACY_SUPPORT_CHAT_TYPE,
    mapSupportChatResult,
    normalizeAction,
    normalizeMessageText,
    SUPPORT_CHAT_TYPE,
  },
} = require("../calls/manageUserSupportChat");

test("general support chat write uses mobile-compatible chat payloads", () => {
  const now = new Date("2026-05-27T00:00:00.000Z");
  const payload = buildGeneralSupportChatWrite({
    chatId: "support-chat-1",
    messageId: "message-1",
    now,
    participantUser: {
      uid: "user-1",
      firstName: "Ana",
      lastName: "Reyes",
      photoUrl: null,
      verified: "Full",
      userMetadataVersion: 3,
    },
    supportUser: {
      uid: "lend_support",
      firstName: "Lend",
      lastName: "Support",
      photoUrl: null,
      verified: "Full",
      userMetadataVersion: 1,
    },
  });

  assert.equal(payload.root.chatType, SUPPORT_CHAT_TYPE);
  assert.equal(payload.root.supportCaseType, GENERAL_SUPPORT_CASE_TYPE);
  assert.equal(payload.root.participantUserId, "user-1");
  assert.equal(payload.root.supportUserId, "lend_support");
  assert.equal(payload.userChat.chatId, "support-chat-1");
  assert.equal(payload.userChat.status, CHAT_STATUS.active);
  assert.equal(payload.userChat.chatType, SUPPORT_CHAT_TYPE);
  assert.equal(payload.userChat.supportCaseType, GENERAL_SUPPORT_CASE_TYPE);
  assert.equal(payload.userChat.participants.length, 2);
  assert.deepEqual(payload.message.visibleTo, ["user-1", "lend_support"]);
  assert.equal(payload.message.type, "system");
});

test("participant user snapshot keeps only chat participant fields", () => {
  const snapshot = getParticipantUserSnapshot({
    id: "user-1",
    user: {
      firstName: "  Bea ",
      lastName: "Santos",
      photoUrl: "https://example.com/avatar.png",
      uid: "custom-user-id",
      userMetadataVersion: 4,
      verified: "Basic",
    },
  });

  assert.deepEqual(snapshot, {
    uid: "custom-user-id",
    firstName: "Bea",
    lastName: "Santos",
    photoUrl: "https://example.com/avatar.png",
    verified: "Basic",
    userMetadataVersion: 4,
  });
});

test("support user snapshot uses configured support identity", () => {
  const previous = process.env.LEND_SUPPORT_USER_ID;
  process.env.LEND_SUPPORT_USER_ID = "configured_support";

  try {
    assert.deepEqual(getSupportUserSnapshot(), {
      uid: "configured_support",
      firstName: "Lend Support",
      lastName: "",
      photoUrl: null,
      verified: "Full",
      userMetadataVersion: 1,
    });
  } finally {
    if (previous === undefined) {
      delete process.env.LEND_SUPPORT_USER_ID;
    } else {
      process.env.LEND_SUPPORT_USER_ID = previous;
    }
  }
});

test("message text normalization trims and caps support messages", () => {
  assert.equal(normalizeMessageText("  Hello user  "), "Hello user");
  assert.equal(normalizeMessageText("x".repeat(2105)).length, 2000);
  assert.throws(() => normalizeMessageText("  "), /Missing message/);
});

test("action normalization accepts only support chat actions", () => {
  assert.equal(normalizeAction("get"), "get");
  assert.equal(normalizeAction("create"), "create");
  assert.equal(normalizeAction("send"), "send");
  assert.equal(normalizeAction("close"), "close");
  assert.equal(normalizeAction("reopen"), "reopen");
  assert.throws(() => normalizeAction("delete"), /Invalid support chat action/);
});

test("general support chat assertion rejects mismatched chat data", () => {
  assert.doesNotThrow(() =>
    assertGeneralSupportChat({
      chat: {
        chatType: SUPPORT_CHAT_TYPE,
        participantUserId: "user-1",
        supportCaseType: GENERAL_SUPPORT_CASE_TYPE,
      },
      chatId: "chat-1",
      userChat: { chatId: "chat-1" },
      userId: "user-1",
    }),
  );

  assert.doesNotThrow(() =>
    assertGeneralSupportChat({
      chat: {
        chatType: LEGACY_SUPPORT_CHAT_TYPE,
        participantUserId: "user-1",
        supportCaseType: GENERAL_SUPPORT_CASE_TYPE,
      },
      chatId: "chat-1",
      userChat: { chatId: "chat-1" },
      userId: "user-1",
    }),
  );

  assert.throws(
    () =>
      assertGeneralSupportChat({
        chat: {
          chatType: "Support",
          participantUserId: "user-2",
          supportCaseType: GENERAL_SUPPORT_CASE_TYPE,
        },
        chatId: "chat-1",
        userChat: { chatId: "chat-1" },
        userId: "user-1",
      }),
    /Support chat does not match this user/,
  );
});

test("support chat result falls back to root status when mirror status is missing", () => {
  const result = mapSupportChatResult({
    chatId: "chat-1",
    root: { status: CHAT_STATUS.archived },
    userChat: {},
  });

  assert.deepEqual(result, {
    chatId: "chat-1",
    createdAt: null,
    lastMessage: null,
    lastMessageDate: null,
    status: CHAT_STATUS.archived,
  });
});
