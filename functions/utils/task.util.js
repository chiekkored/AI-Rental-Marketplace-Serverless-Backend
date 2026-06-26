const { OAuth2Client } = require("google-auth-library");
const { PRIMARY_FUNCTIONS_REGION } = require("./functionsRegion.util");

const oauthClient = new OAuth2Client();
const DEFAULT_FIREBASE_PROJECT_ID = "lend-api";
const DEFAULT_FUNCTIONS_EMULATOR_HOST = "127.0.0.1";
const DEFAULT_FUNCTIONS_EMULATOR_PORT = "5001";

function getTaskServiceAccountEmail(projectId) {
  return process.env.TASKS_SERVICE_ACCOUNT_EMAIL || `${projectId}@appspot.gserviceaccount.com`;
}

function isFunctionsEmulator(env = process.env) {
  return env.FUNCTIONS_EMULATOR === "true";
}

function getFirebaseConfigProjectId(firebaseConfig) {
  if (!firebaseConfig) {
    return null;
  }

  if (typeof firebaseConfig === "object") {
    return firebaseConfig.projectId || null;
  }

  try {
    return JSON.parse(firebaseConfig).projectId || null;
  } catch (_) {
    return null;
  }
}

function resolveProjectId(env = process.env) {
  return (
    env.GCP_PROJECT ||
    env.GCLOUD_PROJECT ||
    getFirebaseConfigProjectId(env.FIREBASE_CONFIG) ||
    DEFAULT_FIREBASE_PROJECT_ID
  );
}

function getDeclineOverlappingBookingsUrl({ env = process.env, projectId } = {}) {
  const resolvedProjectId = projectId || resolveProjectId(env);

  if (!isFunctionsEmulator(env)) {
    return (
      env.DECLINE_FUNCTIONS_URL ||
      `https://${PRIMARY_FUNCTIONS_REGION}-${resolvedProjectId}.cloudfunctions.net/declineOverlappingBookings`
    );
  }

  const host = env.FUNCTIONS_EMULATOR_HOST || DEFAULT_FUNCTIONS_EMULATOR_HOST;
  const port = env.FUNCTIONS_EMULATOR_PORT || DEFAULT_FUNCTIONS_EMULATOR_PORT;

  return `http://${host}:${port}/${resolvedProjectId}/${PRIMARY_FUNCTIONS_REGION}/declineOverlappingBookings`;
}

function isEmulatorRequest(request) {
  return (
    isFunctionsEmulator() || request.get("host")?.includes("localhost") || request.get("host")?.includes("127.0.0.1")
  );
}

async function verifyCloudTaskRequest(request) {
  if (isEmulatorRequest(request)) {
    return;
  }

  const authorization = request.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    throw new Error("Missing OIDC bearer token");
  }

  const idToken = authorization.slice("Bearer ".length);
  const audience = `https://${request.get("host")}${request.originalUrl}`;
  const projectId = resolveProjectId();
  const expectedEmail = getTaskServiceAccountEmail(projectId);

  const ticket = await oauthClient.verifyIdToken({
    idToken,
    audience,
  });

  const payload = ticket.getPayload();
  if (!payload?.email || payload.email !== expectedEmail) {
    throw new Error("Unexpected Cloud Tasks service account");
  }
}

module.exports = {
  getDeclineOverlappingBookingsUrl,
  getTaskServiceAccountEmail,
  isFunctionsEmulator,
  resolveProjectId,
  verifyCloudTaskRequest,
};
