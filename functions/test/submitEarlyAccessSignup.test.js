const assert = require("node:assert/strict");
const test = require("node:test");
const {
  submitEarlyAccessSignup,
} = require("../calls/early-access/submitEarlyAccessSignup");
const {
  EARLY_ACCESS_COLLECTION,
  EARLY_ACCESS_RATE_LIMIT_COLLECTION,
  EARLY_ACCESS_RATE_LIMIT_MAX_ATTEMPTS,
  EARLY_ACCESS_RATE_LIMIT_WINDOW_MS,
  hashEarlyAccessValue,
  normalizeEarlyAccessEmail,
} = require("../calls/early-access/earlyAccessSignup.util");

const fixedNow = Date.parse("2026-06-17T01:00:00.000Z");

test("normalizeEarlyAccessEmail trims, lowercases, and validates email", () => {
  assert.equal(
    normalizeEarlyAccessEmail("  USER@Example.COM  "),
    "user@example.com",
  );
  assert.throws(() => normalizeEarlyAccessEmail("not-an-email"), {
    code: "invalid-argument",
  });
  assert.throws(() => normalizeEarlyAccessEmail(""), {
    code: "invalid-argument",
  });
  assert.throws(() => normalizeEarlyAccessEmail("x".repeat(255) + "@e.com"), {
    code: "invalid-argument",
  });
});

test("submitEarlyAccessSignup creates one normalized signup", async () => {
  const store = new Map();

  await withFakeFirestore(store, async (db) => {
    const result = await submitEarlyAccessSignup(
      requestFor(" USER@Example.COM ", db),
    );
    const emailHash = hashEarlyAccessValue("user@example.com");
    const signup = store.get(`${EARLY_ACCESS_COLLECTION}/${emailHash}`);

    assert.deepEqual(result, { success: true });
    assert.equal(signup.email, "user@example.com");
    assert.equal(signup.emailHash, emailHash);
    assert.equal(signup.emailedAt, null);
    assert.equal(signup.emailedBy, null);
    assert.equal(signup.source, "early_access_web");
    assert.equal(signup.status, "Pending");
  });
});

test("submitEarlyAccessSignup treats duplicate email as successful no-op", async () => {
  const emailHash = hashEarlyAccessValue("user@example.com");
  const store = new Map([
    [
      `${EARLY_ACCESS_COLLECTION}/${emailHash}`,
      {
        email: "user@example.com",
        emailHash,
        source: "early_access_web",
      },
    ],
  ]);

  await withFakeFirestore(store, async (db) => {
    const result = await submitEarlyAccessSignup(
      requestFor(" USER@example.com ", db),
    );
    const rateLimitKeys = [...store.keys()].filter((key) =>
      key.startsWith(`${EARLY_ACCESS_RATE_LIMIT_COLLECTION}/`),
    );

    assert.deepEqual(result, { success: true });
    assert.deepEqual(rateLimitKeys, []);
  });
});

test("submitEarlyAccessSignup rejects the sixth new signup in one hour", async () => {
  const ipHash = hashEarlyAccessValue("127.0.0.1");
  const store = new Map([
    [
      `${EARLY_ACCESS_RATE_LIMIT_COLLECTION}/${ipHash}`,
      {
        attemptCount: EARLY_ACCESS_RATE_LIMIT_MAX_ATTEMPTS,
        updatedAt: new Date(fixedNow),
        windowStartedAt: new Date(fixedNow),
      },
    ],
  ]);

  await withFakeFirestore(store, async (db) => {
    await assert.rejects(
      submitEarlyAccessSignup(requestFor("new@example.com", db)),
      { code: "resource-exhausted" },
    );
  });
});

test("submitEarlyAccessSignup resets rate limit after the window", async () => {
  const ipHash = hashEarlyAccessValue("127.0.0.1");
  const oldWindowStart = fixedNow - EARLY_ACCESS_RATE_LIMIT_WINDOW_MS;
  const store = new Map([
    [
      `${EARLY_ACCESS_RATE_LIMIT_COLLECTION}/${ipHash}`,
      {
        attemptCount: EARLY_ACCESS_RATE_LIMIT_MAX_ATTEMPTS,
        updatedAt: new Date(oldWindowStart),
        windowStartedAt: new Date(oldWindowStart),
      },
    ],
  ]);

  await withFakeFirestore(store, async (db) => {
    await submitEarlyAccessSignup(requestFor("new@example.com", db));

    const updatedLimit = store.get(`${EARLY_ACCESS_RATE_LIMIT_COLLECTION}/${ipHash}`);
    assert.equal(updatedLimit.attemptCount, 1);
    assert.equal(updatedLimit.windowStartedAt.getTime(), fixedNow);
  });
});

function requestFor(email, db) {
  return {
    data: { email },
    rawRequest: {
      headers: {},
      ip: "127.0.0.1",
    },
    _testDb: db,
    _testTimestampFromMillis: (millis) => new Date(millis),
  };
}

async function withFakeFirestore(store, callback) {
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;

  try {
    await callback(createFakeDb(store));
  } finally {
    Date.now = originalDateNow;
  }
}

function createFakeDb(store) {
  return {
    collection: (collectionName) => ({
      doc: (documentId) => ({
        path: `${collectionName}/${documentId}`,
      }),
    }),
    runTransaction: async (transactionCallback) => {
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

      return transactionCallback(transaction);
    },
  };
}
