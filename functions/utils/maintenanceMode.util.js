const { throwAndLogHttpsError } = require("./error.util");
const { getMaintenanceModeEnabledConfig } = require("./remoteConfig.util");

const APP_CONFIG_COLLECTION = "appConfig";
const MAINTENANCE_MODE_DOCUMENT = "maintenance";

async function assertMaintenanceModeDisabled(request) {
  if (request.auth?.token?.admin === true) return;

  const enabled = await getMaintenanceModeEnabledConfig();
  if (enabled) {
    throwAndLogHttpsError(
      "failed-precondition",
      "Lend is under maintenance. Please try again later.",
    );
  }
}

function normalizeMaintenanceEnabled(value) {
  if (value === true) return true;
  if (value === false) return false;
  throwAndLogHttpsError("invalid-argument", "Maintenance mode enabled must be a boolean.");
}

module.exports = {
  APP_CONFIG_COLLECTION,
  MAINTENANCE_MODE_DOCUMENT,
  assertMaintenanceModeDisabled,
  normalizeMaintenanceEnabled,
  _test: {
    normalizeMaintenanceEnabled,
  },
};
