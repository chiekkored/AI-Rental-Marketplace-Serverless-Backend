const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const { normalizePlatform, tokenDocId } = require("../utils/notification.util");

exports.registerFcmToken = async (request) => {
  const auth = request.auth;
  const { token, platform } = request.data || {};

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (typeof token !== "string" || token.trim().length === 0 || token.length > 4096) {
    throwAndLogHttpsError("invalid-argument", "Invalid FCM token");
  }

  const now = admin.firestore?.FieldValue?.serverTimestamp() || new Date();
  const tokenRef = admin.firestore().collection("users").doc(auth.uid).collection("fcmTokens").doc(tokenDocId(token));

  await tokenRef.set(
    {
      token,
      platform: normalizePlatform(platform),
      enabled: true,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    },
    { merge: true },
  );

  return { success: true };
};
