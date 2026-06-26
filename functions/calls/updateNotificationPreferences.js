const admin = require("firebase-admin");
const functions = require("firebase-functions");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  buildNotificationPreferencesWrite,
  notificationPreferencesRef,
  validateNotificationPreferencesUpdate,
} = require("../utils/notificationPreferences.util");

exports.updateNotificationPreferences = async (request) => {
  try {
    const uid = request.auth?.uid;
    if (!uid) {
      throwAndLogHttpsError("permission-denied", "User must be authenticated");
    }

    let preferences;
    try {
      preferences = validateNotificationPreferencesUpdate(request.data?.preferences);
    } catch (error) {
      throwAndLogHttpsError("invalid-argument", error.message);
    }

    await notificationPreferencesRef(admin.firestore(), uid).set(
      buildNotificationPreferencesWrite({ preferences, uid }),
    );

    return { preferences, success: true };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    functions.logger.error("[updateNotificationPreferences] Unexpected error", error);
    throwAndLogHttpsError("internal", "Unable to update notification preferences");
  }
};
