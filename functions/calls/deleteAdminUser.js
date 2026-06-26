const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const {
  authErrorResponse,
  canManageTarget,
  jsonResponse,
  requireAdminManager,
  setCorsHeaders,
} = require("../utils/adminUser.util");

exports.deleteAdminUser = onRequest({ cors: true }, async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method !== "POST") {
    jsonResponse(res, 405, { error: "Method not allowed." });
    return;
  }

  const { uid } = req.body ?? {};
  const normalizedUid = typeof uid === "string" ? uid.trim() : "";

  if (!normalizedUid) {
    jsonResponse(res, 400, { error: "Admin user id is required." });
    return;
  }

  try {
    const caller = await requireAdminManager(req, res);
    if (!caller) {
      return;
    }

    if (caller.uid === normalizedUid) {
      jsonResponse(res, 403, { error: "You cannot delete your own admin user." });
      return;
    }

    const adminUserRef = admin.firestore().collection("adminUsers").doc(normalizedUid);
    const adminUserSnap = await adminUserRef.get();
    if (!adminUserSnap.exists || adminUserSnap.data()?.status === "Deleted") {
      jsonResponse(res, 404, { error: "Admin user was not found." });
      return;
    }

    const targetAdminType = adminUserSnap.data()?.adminType;
    if (!canManageTarget(caller.adminType, targetAdminType)) {
      jsonResponse(res, 403, {
        error: "Admins cannot delete superadmin users.",
      });
      return;
    }

    const authUser = await admin.auth().getUser(normalizedUid);
    const existingClaims = authUser.customClaims ?? {};
    const { admin: _admin, adminType: _adminType, ...remainingClaims } = existingClaims;

    await admin.auth().updateUser(normalizedUid, { disabled: true });
    await admin.auth().setCustomUserClaims(normalizedUid, remainingClaims);
    await adminUserRef.set(
      {
        status: "Deleted",
        deletedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        deletedBy: caller.uid,
        updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        updatedBy: caller.uid,
      },
      { merge: true },
    );

    jsonResponse(res, 200, { ok: true, uid: normalizedUid });
  } catch (error) {
    console.error("Failed to delete admin user", error);
    if (authErrorResponse(error, res, "Unable to delete admin user.")) {
      return;
    }

    jsonResponse(res, 500, { error: "Unable to delete admin user." });
  }
});
