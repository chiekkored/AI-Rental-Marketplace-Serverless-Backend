const assert = require("node:assert/strict");
const test = require("node:test");

const { _test } = require("../utils/storageBucket.util");

test("getStorageBucketName prefers explicit Firebase Storage bucket", () => {
  assert.equal(
    _test.getStorageBucketName({
      LEND_FIREBASE_STORAGE_BUCKET: " lend-api.firebasestorage.app ",
      GCLOUD_PROJECT: "ignored",
    }),
    "lend-api.firebasestorage.app",
  );
});

test("getStorageBucketName derives bucket from project env", () => {
  assert.equal(
    _test.getStorageBucketName({
      GCLOUD_PROJECT: "lend-api",
    }),
    "lend-api.firebasestorage.app",
  );
  assert.equal(
    _test.getStorageBucketName({
      GOOGLE_CLOUD_PROJECT: "lend-api",
    }),
    "lend-api.firebasestorage.app",
  );
  assert.equal(
    _test.getStorageBucketName({
      PROJECT_ID: "lend-api",
    }),
    "lend-api.firebasestorage.app",
  );
});

test("getStorageBucketName returns null when no bucket or project is configured", () => {
  assert.equal(_test.getStorageBucketName({}), null);
});
