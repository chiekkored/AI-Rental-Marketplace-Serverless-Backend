const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const {
  assertValidAdminType,
  authErrorResponse,
  buildAuthUpdatePayload,
  canManageTarget,
  jsonResponse,
  requireAdminManager,
  setCorsHeaders,
  splitDisplayName,
} = require("../utils/adminUser.util");

exports.updateAdminUser = onRequest({ cors: true }, async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method !== "POST") {
    jsonResponse(res, 405, { error: "Method not allowed." });
    return;
  }

  const { uid, displayName, adminType, password } = req.body ?? {};
  const normalizedUid = typeof uid === "string" ? uid.trim() : "";
  const normalizedDisplayName = typeof displayName === "string" ? displayName.trim() : "";
  const normalizedAdminType = typeof adminType === "string" ? adminType.trim().toLowerCase() : "";

  if (!normalizedUid) {
    jsonResponse(res, 400, { error: "Admin user id is required." });
    return;
  }

  if (!assertValidAdminType(normalizedAdminType, res)) {
    return;
  }

  if (password !== undefined && (typeof password !== "string" || password.length < 8)) {
    jsonResponse(res, 400, { error: "Password must be at least 8 characters." });
    return;
  }

  try {
    const caller = await requireAdminManager(req, res);
    if (!caller) {
      return;
    }

    const adminUserRef = admin.firestore().collection("adminUsers").doc(normalizedUid);
    const adminUserSnap = await adminUserRef.get();
    if (!adminUserSnap.exists || adminUserSnap.data()?.status === "Deleted") {
      jsonResponse(res, 404, { error: "Admin user was not found." });
      return;
    }

    const targetAdminType = adminUserSnap.data()?.adminType;
    if (
      !canManageTarget(caller.adminType, targetAdminType) ||
      (caller.adminType === "admin" && normalizedAdminType === "superadmin")
    ) {
      jsonResponse(res, 403, {
        error: "Admins cannot manage superadmin users.",
      });
      return;
    }

    const authPayload = buildAuthUpdatePayload({
      displayName: normalizedDisplayName,
      password,
    });
    if (Object.keys(authPayload).length > 0) {
      await admin.auth().updateUser(normalizedUid, authPayload);
    }

    const authUser = await admin.auth().getUser(normalizedUid);
    const existingClaims = authUser.customClaims ?? {};
    await admin.auth().setCustomUserClaims(normalizedUid, {
      ...existingClaims,
      admin: true,
      adminType: normalizedAdminType,
    });

    const { firstName, lastName } = splitDisplayName(normalizedDisplayName);
    await adminUserRef.set(
      {
        adminType: normalizedAdminType,
        displayName: normalizedDisplayName || authUser.displayName || null,
        firstName,
        lastName,
        status: "Active",
        updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        updatedBy: caller.uid,
      },
      { merge: true },
    );

    jsonResponse(res, 200, {
      ok: true,
      uid: normalizedUid,
      admin: true,
      adminType: normalizedAdminType,
    });
  } catch (error) {
    console.error("Failed to update admin user", error);
    if (authErrorResponse(error, res, "Unable to update admin user.")) {
      return;
    }

    jsonResponse(res, 500, { error: "Unable to update admin user." });
  }
});
