const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  APP_CONFIG_COLLECTION,
  MAINTENANCE_MODE_DOCUMENT,
  normalizeMaintenanceEnabled,
} = require("../utils/maintenanceMode.util");
const { MAINTENANCE_MODE_ENABLED_PARAMETER } = require("../utils/remoteConfig.util");

async function setMaintenanceMode(request) {
  assertAdmin(request.auth);

  try {
    const enabled = normalizeMaintenanceEnabled(request.data?.enabled);
    const adminUid = request.auth.uid;
    const template = await admin.remoteConfig().getTemplate();

    template.parameters[MAINTENANCE_MODE_ENABLED_PARAMETER] = {
      ...(template.parameters[MAINTENANCE_MODE_ENABLED_PARAMETER] || {}),
      defaultValue: { value: enabled ? "true" : "false" },
      description: "Blocks user-facing Lend mobile access and protected user callables during maintenance.",
    };

    await admin.remoteConfig().publishTemplate(template);

    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
    await admin
      .firestore()
      .collection(APP_CONFIG_COLLECTION)
      .doc(MAINTENANCE_MODE_DOCUMENT)
      .set(
        {
          enabled,
          updatedAt: now,
          updatedBy: adminUid,
        },
        { merge: true },
      );

    return {
      success: true,
      maintenance: {
        enabled,
        updatedBy: adminUid,
      },
    };
  } catch (error) {
    if (error?.code) throw error;
    throwAndLogHttpsError("internal", error.message || "Unable to update maintenance mode.");
  }
}

function assertAdmin(auth) {
  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }
  if (auth.token?.admin !== true) {
    throwAndLogHttpsError("permission-denied", "Only admins can manage maintenance mode.");
  }
}

module.exports = {
  setMaintenanceMode,
  _test: {
    assertAdmin,
  },
};
