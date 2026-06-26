const test = require("node:test");
const assert = require("node:assert/strict");
const { tokenDocId, normalizePlatform, _test } = require("../utils/notification.util");
const {
  resolvePushCategory,
  validateNotificationPreferencesUpdate,
} = require("../utils/notificationPreferences.util");

test("tokenDocId hashes tokens deterministically", () => {
  assert.equal(tokenDocId("abc"), tokenDocId("abc"));
  assert.notEqual(tokenDocId("abc"), tokenDocId("def"));
  assert.equal(tokenDocId("abc").length, 64);
});

test("normalizePlatform allows mobile platforms only", () => {
  assert.equal(normalizePlatform("android"), "android");
  assert.equal(normalizePlatform("ios"), "ios");
  assert.equal(normalizePlatform("web"), "unknown");
  assert.equal(normalizePlatform(undefined), "unknown");
});

test("stringifyData removes empty values and stringifies payload values", () => {
  assert.deepEqual(
    _test.stringifyData({
      type: "chat",
      chatId: 123,
      missing: null,
      absent: undefined,
      enabled: true,
    }),
    {
      type: "chat",
      chatId: "123",
      enabled: "true",
    },
  );
});

test("firstListingImageUrl picks the first listing image with showcase fallback", () => {
  assert.equal(
    _test.firstListingImageUrl({
      images: ["", " https://cdn.example.com/image.jpg "],
      showcase: ["https://cdn.example.com/showcase.jpg"],
    }),
    "https://cdn.example.com/image.jpg",
  );
  assert.equal(
    _test.firstListingImageUrl({
      images: [],
      showcase: ["storage/path/showcase.jpg"],
    }),
    "storage/path/showcase.jpg",
  );
  assert.equal(_test.firstListingImageUrl({ images: [], showcase: [] }), null);
});

test("normalizePushImageUrl only allows http image URLs for FCM image fields", () => {
  assert.equal(
    _test.normalizePushImageUrl(" https://cdn.example.com/image.jpg "),
    "https://cdn.example.com/image.jpg",
  );
  assert.equal(_test.normalizePushImageUrl("storage/path/image.jpg"), null);
  assert.equal(_test.normalizePushImageUrl("ftp://cdn.example.com/image.jpg"), null);
});

test("isInvalidTokenError recognizes FCM cleanup errors", () => {
  assert.equal(
    _test.isInvalidTokenError({ code: "messaging/invalid-registration-token" }),
    true,
  );
  assert.equal(
    _test.isInvalidTokenError({ code: "messaging/registration-token-not-registered" }),
    true,
  );
  assert.equal(_test.isInvalidTokenError({ code: "messaging/internal-error" }), false);
});

test("sendNotificationToUser creates an in-app notification before sending FCM", async () => {
  const writes = [];
  const sentPayloads = [];
  const deletes = [];

  function firestore() {
    return {
    collection: (name) => {
      assert.equal(name, "users");
      return {
        doc: (uid) => ({
          collection: (collectionName) => {
            if (collectionName === "notifications") {
              return {
                add: async (payload) => {
                  writes.push({ uid, payload });
                  return { id: "notification-1" };
                },
              };
            }

            assert.equal(collectionName, "fcmTokens");
            return {
              where: () => ({
                get: async () => ({
                  docs: [
                    {
                      data: () => ({ token: "token-1" }),
                      ref: { delete: async () => deletes.push("token-1") },
                    },
                  ],
                }),
              }),
            };
          },
        }),
      };
    },
  };
  }
  firestore.FieldValue = {
    serverTimestamp: () => "server-timestamp",
  };

  const adminClient = {
    firestore,
    messaging: () => ({
    sendEachForMulticast: async (payload) => {
      sentPayloads.push(payload);
      return { successCount: 1, failureCount: 0, responses: [{ success: true }] };
    },
    }),
  };

  const result = await require("../utils/notification.util").sendNotificationToUser({
      uid: "user-1",
      title: "Title",
      body: "Body",
      data: { type: "verification", status: "Approved", empty: null },
    },
    adminClient,
  );

  assert.equal(result.notificationId, "notification-1");
  assert.equal(result.successCount, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].uid, "user-1");
  assert.deepEqual(writes[0].payload.data, {
    type: "verification",
    status: "Approved",
  });
  assert.equal(writes[0].payload.type, "verification");
  assert.deepEqual(sentPayloads[0].data, {
    ...writes[0].payload.data,
    notificationId: "notification-1",
  });
  assert.equal(sentPayloads[0].notification.imageUrl, undefined);
  assert.deepEqual(deletes, []);
});

test("sendNotificationToUser stores and sends notification images when URL is push-safe", async () => {
  const writes = [];
  const sentPayloads = [];

  function firestore() {
    return {
      collection: () => ({
        doc: (uid) => ({
          collection: (collectionName) => {
            if (collectionName === "notifications") {
              return {
                add: async (payload) => {
                  writes.push({ uid, payload });
                  return { id: "notification-image" };
                },
              };
            }

            return {
              where: () => ({
                get: async () => ({
                  docs: [
                    {
                      data: () => ({ token: "token-1" }),
                      ref: { delete: async () => {} },
                    },
                  ],
                }),
              }),
            };
          },
        }),
      }),
    };
  }
  firestore.FieldValue = {
    serverTimestamp: () => "server-timestamp",
  };

  const adminClient = {
    firestore,
    messaging: () => ({
      sendEachForMulticast: async (payload) => {
        sentPayloads.push(payload);
        return { successCount: 1, failureCount: 0, responses: [{ success: true }] };
      },
    }),
  };

  await require("../utils/notification.util").sendNotificationToUser(
    {
      uid: "user-1",
      title: "Title",
      body: "Body",
      imageUrl: "https://cdn.example.com/photo.jpg",
      data: { type: "chat" },
    },
    adminClient,
  );

  assert.equal(writes[0].payload.data.imageUrl, "https://cdn.example.com/photo.jpg");
  assert.equal(sentPayloads[0].data.imageUrl, "https://cdn.example.com/photo.jpg");
  assert.equal(sentPayloads[0].notification.imageUrl, "https://cdn.example.com/photo.jpg");
  assert.equal(sentPayloads[0].android.notification.imageUrl, "https://cdn.example.com/photo.jpg");
  assert.equal(sentPayloads[0].apns.payload.aps["mutable-content"], 1);
  assert.deepEqual(sentPayloads[0].apns.fcmOptions, {
    imageUrl: "https://cdn.example.com/photo.jpg",
  });
});

test("sendNotificationToUser stores non-URL image paths without FCM image fields", async () => {
  const writes = [];
  const sentPayloads = [];

  function firestore() {
    return {
      collection: () => ({
        doc: () => ({
          collection: (collectionName) => {
            if (collectionName === "notifications") {
              return {
                add: async (payload) => {
                  writes.push(payload);
                  return { id: "notification-path" };
                },
              };
            }

            return {
              where: () => ({
                get: async () => ({
                  docs: [
                    {
                      data: () => ({ token: "token-1" }),
                      ref: { delete: async () => {} },
                    },
                  ],
                }),
              }),
            };
          },
        }),
      }),
    };
  }
  firestore.FieldValue = {
    serverTimestamp: () => "server-timestamp",
  };

  const adminClient = {
    firestore,
    messaging: () => ({
      sendEachForMulticast: async (payload) => {
        sentPayloads.push(payload);
        return { successCount: 1, failureCount: 0, responses: [{ success: true }] };
      },
    }),
  };

  await require("../utils/notification.util").sendNotificationToUser(
    {
      uid: "user-1",
      title: "Title",
      body: "Body",
      imageUrl: "users/user-1/listingDrafts/draft/images/photo.jpg",
      data: { type: "listing_review" },
    },
    adminClient,
  );

  assert.equal(writes[0].data.imageUrl, "users/user-1/listingDrafts/draft/images/photo.jpg");
  assert.equal(sentPayloads[0].data.imageUrl, "users/user-1/listingDrafts/draft/images/photo.jpg");
  assert.equal(sentPayloads[0].notification.imageUrl, undefined);
  assert.equal(sentPayloads[0].android.notification.imageUrl, undefined);
  assert.equal(sentPayloads[0].apns.fcmOptions, undefined);
});

test("sendNotificationToUser still creates an in-app notification without FCM tokens", async () => {
  const writes = [];

  function firestore() {
    return {
    collection: () => ({
      doc: (uid) => ({
        collection: (collectionName) => {
          if (collectionName === "notifications") {
            return {
              add: async (payload) => {
                writes.push({ uid, payload });
                return { id: "notification-2" };
              },
            };
          }

          return {
            where: () => ({
              get: async () => ({ docs: [] }),
            }),
          };
        },
      }),
    }),
  };
  }
  firestore.FieldValue = {
    serverTimestamp: () => "server-timestamp",
  };

  const adminClient = {
    firestore,
  };

  const result = await require("../utils/notification.util").sendNotificationToUser({
      uid: "user-1",
      title: "Title",
      body: "Body",
    },
    adminClient,
  );

  assert.deepEqual(result, {
    successCount: 0,
    failureCount: 0,
    notificationId: "notification-2",
  });
  assert.equal(writes.length, 1);
});

test("sendNotificationToUser can send push-only notifications", async () => {
  const sentPayloads = [];

  function firestore() {
    return {
    collection: () => ({
      doc: () => ({
        collection: (collectionName) => {
          assert.equal(collectionName, "fcmTokens");
          return {
            where: () => ({
              get: async () => ({
                docs: [
                  {
                    data: () => ({ token: "token-1" }),
                    ref: { delete: async () => {} },
                  },
                ],
              }),
            }),
          };
        },
      }),
    }),
  };
  }

  const adminClient = {
    firestore,
    messaging: () => ({
    sendEachForMulticast: async (payload) => {
      sentPayloads.push(payload);
      return { successCount: 1, failureCount: 0, responses: [{ success: true }] };
    },
    }),
  };

  const result = await require("../utils/notification.util").sendNotificationToUser({
      uid: "user-1",
      title: "New message",
      body: "Hello",
      persist: false,
      data: { type: "chat", chatId: "chat-1" },
    },
    adminClient,
  );

  assert.deepEqual(result, {
    successCount: 1,
    failureCount: 0,
    notificationId: null,
  });
  assert.deepEqual(sentPayloads[0].data, {
    type: "chat",
    chatId: "chat-1",
  });
});

test("sendNotificationToUser can create in-app notification without direct push", async () => {
  const writes = [];
  let messagingCalled = false;

  function firestore() {
    return {
      collection: () => ({
        doc: (uid) => ({
          collection: (collectionName) => {
            if (collectionName === "notifications") {
              return {
                add: async (payload) => {
                  writes.push({ uid, payload });
                  return { id: "notification-3" };
                },
              };
            }

            throw new Error("FCM tokens should not be queried when push is false");
          },
        }),
      }),
    };
  }
  firestore.FieldValue = {
    serverTimestamp: () => "server-timestamp",
  };

  const adminClient = {
    firestore,
    messaging: () => {
      messagingCalled = true;
      return {
        sendEachForMulticast: async () => ({ successCount: 0, failureCount: 0, responses: [] }),
      };
    },
  };

  const result = await require("../utils/notification.util").sendNotificationToUser(
    {
      uid: "user-1",
      title: "Cancellation in process",
      body: "Camera for Apr 10, 2026 is under review.",
      push: false,
    },
    adminClient,
  );

  assert.deepEqual(result, {
    successCount: 0,
    failureCount: 0,
    notificationId: "notification-3",
  });
  assert.equal(writes.length, 1);
  assert.equal(messagingCalled, false);
});

test("notification preferences validate known channels and categories only", () => {
  assert.deepEqual(
    validateNotificationPreferencesUpdate({
      channels: { push: false },
      pushCategories: { messages: false, payments: true },
      emailCategories: { bookings: false },
    }),
    {
      version: 1,
      channels: { push: false },
      pushCategories: {
        messages: false,
        bookings: true,
        payments: true,
        listings: true,
        verification: true,
      },
      emailCategories: { bookings: false, payments: true },
    },
  );

  assert.throws(
    () => validateNotificationPreferencesUpdate({ pushCategories: { spam: false } }),
    /pushCategories\.spam is not supported/,
  );
  assert.throws(
    () => validateNotificationPreferencesUpdate({ channels: { push: "no" } }),
    /channels\.push must be a boolean/,
  );
});

test("resolvePushCategory maps notification payloads to preference categories", () => {
  assert.equal(resolvePushCategory({ type: "chat" }), "messages");
  assert.equal(resolvePushCategory({ type: "booking" }), "bookings");
  assert.equal(resolvePushCategory({ type: "booking", notificationCategory: "payments" }), "payments");
  assert.equal(resolvePushCategory({ type: "listing_moderation" }), "listings");
  assert.equal(resolvePushCategory({ type: "business_registration" }), "verification");
  assert.equal(resolvePushCategory({ type: "general" }), null);
});

test("sendNotificationToUser skips FCM when push master preference is disabled", async () => {
  const writes = [];
  let tokenQueried = false;
  let messagingCalled = false;

  const adminClient = notificationPreferenceAdmin({
    preferences: { channels: { push: false } },
    writes,
    onTokenQuery: () => {
      tokenQueried = true;
    },
    onMessaging: () => {
      messagingCalled = true;
    },
  });

  const result = await require("../utils/notification.util").sendNotificationToUser(
    {
      uid: "user-1",
      title: "Title",
      body: "Body",
      data: { type: "chat" },
    },
    adminClient,
  );

  assert.equal(result.pushSkipped, true);
  assert.equal(result.notificationId, "notification-pref");
  assert.equal(writes.length, 1);
  assert.equal(tokenQueried, false);
  assert.equal(messagingCalled, false);
});

test("sendNotificationToUser skips FCM when push category preference is disabled", async () => {
  const writes = [];
  let tokenQueried = false;

  const adminClient = notificationPreferenceAdmin({
    preferences: { pushCategories: { messages: false } },
    writes,
    onTokenQuery: () => {
      tokenQueried = true;
    },
  });

  const result = await require("../utils/notification.util").sendNotificationToUser(
    {
      uid: "user-1",
      title: "New message",
      body: "Hello",
      persist: false,
      data: { type: "chat", chatId: "chat-1" },
    },
    adminClient,
  );

  assert.deepEqual(result, {
    successCount: 0,
    failureCount: 0,
    notificationId: null,
    pushSkipped: true,
  });
  assert.equal(writes.length, 0);
  assert.equal(tokenQueried, false);
});

function notificationPreferenceAdmin({ preferences, writes, onMessaging, onTokenQuery }) {
  function firestore() {
    return {
      collection: () => ({
        doc: (uid) => ({
          collection: (collectionName) => {
            if (collectionName === "notifications") {
              return {
                add: async (payload) => {
                  writes.push({ uid, payload });
                  return { id: "notification-pref" };
                },
              };
            }

            if (collectionName === "private") {
              return {
                doc: () => ({
                  get: async () => ({ exists: true, data: () => preferences }),
                }),
              };
            }

            if (collectionName === "fcmTokens") {
              onTokenQuery?.();
              return {
                where: () => ({
                  get: async () => ({ docs: [] }),
                }),
              };
            }

            throw new Error(`Unexpected collection ${collectionName}`);
          },
        }),
      }),
    };
  }
  firestore.FieldValue = {
    serverTimestamp: () => "server-timestamp",
  };

  return {
    firestore,
    messaging: () => {
      onMessaging?.();
      return {
        sendEachForMulticast: async () => ({ successCount: 0, failureCount: 0, responses: [] }),
      };
    },
  };
}
