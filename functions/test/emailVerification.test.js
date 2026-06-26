const assert = require("node:assert/strict");
const test = require("node:test");
const {
  EMAIL_VERIFICATION_RATE_LIMIT_COLLECTION,
  EMAIL_VERIFICATION_TOKENS_COLLECTION,
  requestEmailVerification,
  verifyEmailToken,
  _test,
} = require("../calls/emailVerification");

test("buildVerificationLink appends token", () => {
  assert.equal(
    _test.buildVerificationLink("abc", { EMAIL_VERIFICATION_BASE_URL: "https://getlend.dev/email/verify" }),
    "https://getlend.dev/email/verify?token=abc",
  );
});

test("hashVerificationToken hashes token", () => {
  assert.equal(_test.hashVerificationToken("a"), _test.hashVerificationToken("a"));
  assert.notEqual(_test.hashVerificationToken("a"), _test.hashVerificationToken("b"));
});

test("requestEmailVerification creates a token and sends email", async () => {
  const store = new Map();
  const sends = [];

  const result = await requestEmailVerification({
    auth: { uid: "user-1" },
    _testAdmin: fakeAdmin(store, {
      users: { "user-1": { email: "User@Example.com", emailVerified: false } },
    }),
    _testAuth: fakeAuth({ "user-1": { email: "User@Example.com", emailVerified: false } }),
    _testDb: fakeDb(store),
    _testEnv: {
      EMAIL_VERIFICATION_BASE_URL: "https://getlend.dev/email/verify",
      RESEND_API_KEY: "key",
      RESEND_FROM_EMAIL: "Lend <no-reply@example.com>",
    },
    _testResend: {
      emails: {
        send: async (payload) => {
          sends.push(payload);
          return { id: "email-1" };
        },
      },
    },
    _testTimestampFromMillis: (millis) => new Date(millis),
  });

  assert.deepEqual(result, { autoVerified: false, emailSent: true, success: true });
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /https:\/\/getlend\.dev\/email\/verify\?token=/);
  assert.equal(
    [...store.keys()].filter((key) => key.startsWith(`${EMAIL_VERIFICATION_TOKENS_COLLECTION}/`)).length,
    1,
  );
});

test("requestEmailVerification auto-verifies without token or email when disabled", async () => {
  const store = new Map([
    ["users/user-1", { email: "user@example.com", userMetadataVersion: 4, verified: "None" }],
  ]);
  const users = { "user-1": { email: "user@example.com", emailVerified: false } };
  let sendCount = 0;

  const result = await requestEmailVerification({
    auth: { uid: "user-1" },
    _testAdmin: fakeAdmin(store, { users }),
    _testAuth: fakeAuth(users),
    _testDb: fakeDb(store),
    _testTransactionalEmailEnabled: false,
    _testResend: { emails: { send: async () => { sendCount += 1; } } },
  });

  assert.deepEqual(result, { autoVerified: true, emailSent: false, success: true });
  assert.equal(users["user-1"].emailVerified, true);
  assert.deepEqual(store.get("users/user-1"), {
    email: "user@example.com",
    userMetadataVersion: 5,
    verified: "Basic",
  });
  assert.equal(sendCount, 0);
  assert.equal(
    [...store.keys()].some((key) => key.startsWith(`${EMAIL_VERIFICATION_TOKENS_COLLECTION}/`)),
    false,
  );
  assert.equal(store.has(`${EMAIL_VERIFICATION_RATE_LIMIT_COLLECTION}/user-1`), false);
});

test("disabled email verification preserves Full verification", async () => {
  const store = new Map([
    ["users/user-1", { userMetadataVersion: 9, verified: "Full" }],
  ]);
  const users = { "user-1": { email: "user@example.com", emailVerified: true } };

  const result = await requestEmailVerification({
    auth: { uid: "user-1" },
    _testAdmin: fakeAdmin(store, { users }),
    _testAuth: fakeAuth(users),
    _testDb: fakeDb(store),
    _testTransactionalEmailEnabled: false,
  });

  assert.equal(result.autoVerified, true);
  assert.deepEqual(store.get("users/user-1"), { userMetadataVersion: 9, verified: "Full" });
});

test("verifyEmailToken rejects invalid token", async () => {
  const result = await verifyEmailToken({
    adminClient: fakeAdmin(new Map(), { users: {} }),
    token: "missing",
  });

  assert.deepEqual(result, { code: "invalid", success: false });
});

test("verifyEmailToken consumes valid token and updates auth user", async () => {
  const token = "token-1";
  const tokenHash = _test.hashVerificationToken(token);
  const users = { "user-1": { email: "user@example.com", emailVerified: false } };
  const store = new Map([
    [
      `${EMAIL_VERIFICATION_TOKENS_COLLECTION}/${tokenHash}`,
      {
        consumedAt: null,
        email: "user@example.com",
        expiresAtMs: Date.now() + 10000,
        uid: "user-1",
      },
    ],
  ]);

  const result = await verifyEmailToken({
    adminClient: fakeAdmin(store, { users }),
    token,
  });

  assert.deepEqual(result, { success: true });
  assert.equal(users["user-1"].emailVerified, true);
  assert.equal(store.get(`${EMAIL_VERIFICATION_TOKENS_COLLECTION}/${tokenHash}`).consumedAt, "server-timestamp");
});

function fakeAdmin(store, { users }) {
  const db = fakeDb(store);
  function firestore() {
    return db;
  }
  firestore.FieldValue = {
    serverTimestamp: () => "server-timestamp",
  };
  return {
    auth: () => fakeAuth(users),
    firestore,
  };
}

function fakeAuth(users) {
  return {
    getUser: async (uid) => {
      if (!users[uid]) throw new Error("missing user");
      return users[uid];
    },
    updateUser: async (uid, update) => {
      users[uid] = { ...users[uid], ...update };
      return users[uid];
    },
  };
}

function fakeDb(store) {
  return {
    collection: (collectionName) => ({
      doc: (documentId) => {
        const path = `${collectionName}/${documentId}`;
        return {
          create: async (value) => {
            if (store.has(path)) {
              const error = new Error("already exists");
              error.code = 6;
              throw error;
            }
            store.set(path, value);
          },
          path,
          set: async (value, options) => {
            const current = options?.merge ? store.get(path) || {} : {};
            store.set(path, { ...current, ...value });
          },
        };
      },
    }),
    runTransaction: async (callback) => {
      const transaction = {
        get: async (ref) => ({
          exists: store.has(ref.path),
          data: () => store.get(ref.path),
        }),
        set: (ref, value, options) => {
          const current = options?.merge ? store.get(ref.path) || {} : {};
          store.set(ref.path, { ...current, ...value });
        },
      };
      return callback(transaction);
    },
  };
}
