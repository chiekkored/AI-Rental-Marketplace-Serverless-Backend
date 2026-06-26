const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const { tokenDocId } = require("../utils/notification.util");

exports.unregisterFcmToken = async (request) => {
  const auth = request.auth;
  const { token } = request.data || {};

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (typeof token !== "string" || token.trim().length === 0 || token.length > 4096) {
    throwAndLogHttpsError("invalid-argument", "Invalid FCM token");
  }

  await admin
    .firestore()
    .collection("users")
    .doc(auth.uid)
    .collection("fcmTokens")
    .doc(tokenDocId(token))
    .set(
      {
        enabled: false,
        updatedAt: admin.firestore?.FieldValue?.serverTimestamp() || new Date(),
      },
      { merge: true },
    );

  return { success: true };
};
