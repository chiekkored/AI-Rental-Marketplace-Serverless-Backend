const admin = require("firebase-admin");

const ADMIN_TYPES = new Set(["superadmin", "admin", "moderator", "finance"]);
const MANAGER_TYPES = new Set(["superadmin", "admin"]);

function setCorsHeaders(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function jsonResponse(res, status, body) {
  res.status(status).json(body);
}

async function requireAdminManager(req, res) {
  const authHeader = req.get("Authorization") ?? "";
  const [, idToken] = authHeader.match(/^Bearer (.+)$/) ?? [];

  if (!idToken) {
    jsonResponse(res, 401, { error: "Missing authorization token." });
    return null;
  }

  const decodedToken = await admin.auth().verifyIdToken(idToken);
  const callerAdminType = decodedToken.adminType;

  if (decodedToken.admin !== true || !MANAGER_TYPES.has(callerAdminType)) {
    jsonResponse(res, 403, { error: "Not authorized to manage admin users." });
    return null;
  }

  return {
    uid: decodedToken.uid,
    adminType: callerAdminType,
  };
}

function canManageTarget(callerAdminType, targetAdminType) {
  return callerAdminType === "superadmin" || targetAdminType !== "superadmin";
}

function assertValidAdminType(adminType, res) {
  if (!ADMIN_TYPES.has(adminType)) {
    jsonResponse(res, 400, { error: "Invalid admin type." });
    return false;
  }

  return true;
}

function splitDisplayName(displayName) {
  if (!displayName) {
    return { firstName: null, lastName: null };
  }

  const parts = displayName.split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? null,
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
}

function buildAuthUpdatePayload({ displayName, password }) {
  const payload = {};

  if (displayName) {
    payload.displayName = displayName;
  }

  if (password) {
    payload.password = password;
  }

  return payload;
}

function authErrorResponse(error, res, fallbackMessage) {
  if (typeof error?.code === "string" && error.code.startsWith("auth/")) {
    jsonResponse(res, 400, {
      error: error.message ?? fallbackMessage,
    });
    return true;
  }

  return false;
}

module.exports = {
  ADMIN_TYPES,
  authErrorResponse,
  buildAuthUpdatePayload,
  canManageTarget,
  jsonResponse,
  requireAdminManager,
  setCorsHeaders,
  splitDisplayName,
  assertValidAdminType,
};
