const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("./error.util");

function getStorageBucketName(env = process.env) {
  const explicit = env.LEND_FIREBASE_STORAGE_BUCKET || env.FIREBASE_STORAGE_BUCKET || env.STORAGE_BUCKET;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }

  const projectId = env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || env.PROJECT_ID;
  if (typeof projectId === "string" && projectId.trim()) {
    return `${projectId.trim()}.firebasestorage.app`;
  }

  return null;
}

function getStorageBucket({ env = process.env, storage = admin.storage() } = {}) {
  const bucketName = getStorageBucketName(env);
  if (!bucketName) {
    throwAndLogHttpsError("failed-precondition", "Firebase Storage bucket is not configured");
  }
  return storage.bucket(bucketName);
}

module.exports = {
  getStorageBucket,
  getStorageBucketName,
  _test: {
    getStorageBucketName,
  },
};
