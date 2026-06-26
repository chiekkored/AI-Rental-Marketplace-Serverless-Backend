const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getEmailVerificationBaseUrl,
  hashEventKey,
  normalizeEmail,
  sendTransactionalEmail,
  sendTransactionalEmailToUser,
  _test,
} = require("../utils/email.util");

test("normalizeEmail trims, lowercases, and validates email", () => {
  assert.equal(normalizeEmail(" USER@Example.COM "), "user@example.com");
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeEmail(""), null);
});

test("getEmailVerificationBaseUrl uses explicit value or web fallback", () => {
  assert.equal(
    getEmailVerificationBaseUrl({ EMAIL_VERIFICATION_BASE_URL: "https://example.com/verify?" }),
    "https://example.com/verify",
  );
  assert.equal(
    getEmailVerificationBaseUrl({ LEND_WEB_BASE_URL: "https://getlend.dev/" }),
    "https://getlend.dev/email/verify",
  );
});

test("hashEventKey hashes deterministic event ids", () => {
  assert.equal(hashEventKey("abc"), hashEventKey("abc"));
  assert.notEqual(hashEventKey("abc"), hashEventKey("def"));
  assert.equal(hashEventKey("abc").length, 64);
});

test("textToHtml escapes paragraphs", () => {
  assert.equal(
    _test.textToHtml("Hello <user>\n\nOpen Lend"),
    "<p>Hello &lt;user&gt;</p><p>Open Lend</p>",
  );
});

test("sendTransactionalEmail skips duplicate event keys", async () => {
  const store = new Map([[`emailEvents/${hashEventKey("event-1")}`, { status: "sent" }]]);
  const result = await sendTransactionalEmail(
    {
      idempotencyKey: "event-1",
      subject: "Subject",
      text: "Body",
      to: "user@example.com",
    },
    {
      adminClient: fakeAdmin(store),
      env: { RESEND_API_KEY: "key", RESEND_FROM_EMAIL: "Lend <no-reply@example.com>" },
    },
  );

  assert.deepEqual(result, { sent: false, skipped: true, reason: "duplicate" });
});

test("sendTransactionalEmail no-ops without Resend config after recording event", async () => {
  const store = new Map();
  const result = await sendTransactionalEmail(
    {
      idempotencyKey: "event-2",
      subject: "Subject",
      text: "Body",
      to: "user@example.com",
    },
    {
      adminClient: fakeAdmin(store),
      env: {},
    },
  );

  assert.equal(result.reason, "missing_config");
  assert.equal(store.get(`emailEvents/${hashEventKey("event-2")}`).status, "skipped");
});

test("sendTransactionalEmail sends provided HTML to Resend", async () => {
  const store = new Map();
  let payload;
  const result = await sendTransactionalEmail(
    {
      html: "<strong>Modern email</strong>",
      idempotencyKey: "event-html",
      subject: "Subject",
      text: "Modern email",
      to: "user@example.com",
    },
    {
      adminClient: fakeAdmin(store),
      env: { RESEND_API_KEY: "key", RESEND_FROM_EMAIL: "Lend <no-reply@example.com>" },
      resendClient: { emails: { send: async (value) => { payload = value; return { data: { id: "email-1" } }; } } },
    },
  );

  assert.equal(result.sent, true);
  assert.equal(payload.html, "<strong>Modern email</strong>");
  assert.equal(payload.text, "Modern email");
});

test("sendTransactionalEmail skips before recording or sending when disabled", async () => {
  const store = new Map();
  let sendCount = 0;
  const result = await sendTransactionalEmail(
    {
      idempotencyKey: "event-disabled",
      subject: "Subject",
      text: "Body",
      to: "user@example.com",
    },
    {
      adminClient: fakeAdmin(store),
      env: { RESEND_API_KEY: "key", RESEND_FROM_EMAIL: "Lend <no-reply@example.com>" },
      resendClient: { emails: { send: async () => { sendCount += 1; } } },
      transactionalEmailEnabled: false,
    },
  );

  assert.deepEqual(result, { sent: false, skipped: true, reason: "email_disabled" });
  assert.equal(sendCount, 0);
  assert.equal(store.size, 0);
});

test("sendTransactionalEmailToUser skips optional email categories disabled by user preference", async () => {
  const store = new Map();
  let authRead = false;
  let sendCount = 0;

  const result = await sendTransactionalEmailToUser(
    {
      uid: "user-1",
      idempotencyKey: "booking-email-disabled",
      subject: "Booking update",
      text: "Body",
    },
    {
      adminClient: fakePreferenceEmailAdmin(store, {
        emailCategories: { bookings: false },
        onAuthRead: () => {
          authRead = true;
        },
      }),
      emailCategory: "bookings",
      env: { RESEND_API_KEY: "key", RESEND_FROM_EMAIL: "Lend <no-reply@example.com>" },
      resendClient: { emails: { send: async () => { sendCount += 1; } } },
      transactionalEmailEnabled: true,
    },
  );

  assert.deepEqual(result, { sent: false, skipped: true, reason: "email_preference_disabled" });
  assert.equal(authRead, false);
  assert.equal(sendCount, 0);
  assert.equal(store.size, 0);
});

test("sendTransactionalEmailToUser treats uncategorized emails as mandatory", async () => {
  const store = new Map();
  let sendCount = 0;

  const result = await sendTransactionalEmailToUser(
    {
      uid: "user-1",
      idempotencyKey: "mandatory-email",
      subject: "Account update",
      text: "Body",
    },
    {
      adminClient: fakePreferenceEmailAdmin(store, {
        emailCategories: { bookings: false, payments: false },
      }),
      env: { RESEND_API_KEY: "key", RESEND_FROM_EMAIL: "Lend <no-reply@example.com>" },
      resendClient: { emails: { send: async () => { sendCount += 1; return { data: { id: "email-1" } }; } } },
      transactionalEmailEnabled: true,
    },
  );

  assert.equal(result.sent, true);
  assert.equal(sendCount, 1);
});

function fakeAdmin(store) {
  function firestore() {
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
            set: async (value, options) => {
              const current = options?.merge ? store.get(path) || {} : {};
              store.set(path, { ...current, ...value });
            },
          };
        },
      }),
    };
  }
  firestore.FieldValue = {
    serverTimestamp: () => "server-timestamp",
  };
  return { firestore };
}

function fakePreferenceEmailAdmin(store, { emailCategories, onAuthRead } = {}) {
  function firestore() {
    return {
      collection: (collectionName) => {
        if (collectionName === "users") {
          return {
            doc: (uid) => ({
              collection: (subcollectionName) => {
                assert.equal(subcollectionName, "private");
                return {
                  doc: (documentId) => {
                    assert.equal(documentId, "notificationPreferences");
                    return {
                      get: async () => ({
                        exists: true,
                        data: () => ({ emailCategories }),
                      }),
                    };
                  },
                };
              },
              get: async () => ({
                data: () => ({ email: `${uid}@example.com` }),
              }),
            }),
          };
        }

        if (collectionName === "emailEvents") {
          return {
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
                set: async (value, options) => {
                  const current = options?.merge ? store.get(path) || {} : {};
                  store.set(path, { ...current, ...value });
                },
              };
            },
          };
        }

        throw new Error(`Unexpected collection ${collectionName}`);
      },
    };
  }
  firestore.FieldValue = {
    serverTimestamp: () => "server-timestamp",
  };

  return {
    auth: () => ({
      getUser: async (uid) => {
        onAuthRead?.();
        return { email: `${uid}@example.com` };
      },
    }),
    firestore,
  };
}
