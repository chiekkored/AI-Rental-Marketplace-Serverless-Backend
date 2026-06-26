const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const {
  authErrorResponse,
  buildAuthUpdatePayload,
  jsonResponse,
  requireAdminManager,
  setCorsHeaders,
  splitDisplayName,
  assertValidAdminType,
} = require("../utils/adminUser.util");

exports.createAdminUser = onRequest({ cors: true }, async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method !== "POST") {
    jsonResponse(res, 405, { error: "Method not allowed." });
    return;
  }

  const { email, password, displayName, adminType } = req.body ?? {};
  const normalizedEmail =
    typeof email === "string" ? email.trim().toLowerCase() : "";
  const normalizedDisplayName =
    typeof displayName === "string" ? displayName.trim() : "";
  const normalizedAdminType =
    typeof adminType === "string" ? adminType.trim().toLowerCase() : "";

  if (!normalizedEmail) {
    jsonResponse(res, 400, { error: "Email is required." });
    return;
  }

  if (typeof password !== "string" || password.length < 8) {
    jsonResponse(res, 400, { error: "Password must be at least 8 characters." });
    return;
  }

  if (!assertValidAdminType(normalizedAdminType, res)) {
    return;
  }

  try {
    const caller = await requireAdminManager(req, res);
    if (!caller) {
      return;
    }

    if (
      caller.adminType === "admin" &&
      normalizedAdminType === "superadmin"
    ) {
      jsonResponse(res, 403, { error: "Admins cannot create superadmin users." });
      return;
    }

    let user;
    let createdAuthUser = false;
    try {
      user = await admin.auth().getUserByEmail(normalizedEmail);
      await admin.auth().updateUser(
        user.uid,
        buildAuthUpdatePayload({
          displayName: normalizedDisplayName,
          password,
        }),
      );
      user = await admin.auth().getUser(user.uid);
    } catch (error) {
      if (error.code !== "auth/user-not-found") {
        throw error;
      }

      const createPayload = {
        email: normalizedEmail,
        password,
        emailVerified: true,
      };
      if (normalizedDisplayName) {
        createPayload.displayName = normalizedDisplayName;
      }

      user = await admin.auth().createUser(createPayload);
      createdAuthUser = true;
    }

    const existingClaims = user.customClaims ?? {};
    await admin.auth().setCustomUserClaims(user.uid, {
      ...existingClaims,
      admin: true,
      adminType: normalizedAdminType,
    });

    const adminUserRef = admin.firestore().collection("adminUsers").doc(user.uid);
    const adminUserSnap = await adminUserRef.get();
    const existingAdminUserData = adminUserSnap.data() ?? {};
    const { firstName, lastName } = splitDisplayName(normalizedDisplayName);
    const profilePayload = {
      uid: user.uid,
      email: normalizedEmail,
      firstName,
      lastName,
      displayName: normalizedDisplayName || user.displayName || null,
      photoUrl: user.photoURL ?? null,
      createdAt:
        adminUserSnap.exists && existingAdminUserData.createdAt
          ? existingAdminUserData.createdAt
          : admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      adminType: normalizedAdminType,
      status: "Active",
      createdBy: existingAdminUserData.createdBy ?? caller.uid,
      updatedBy: caller.uid,
      deletedAt: null,
      deletedBy: null,
    };

    try {
      await adminUserRef.set(profilePayload, { merge: true });
    } catch (error) {
      console.error("Failed to write admin user profile", {
        uid: user.uid,
        email: normalizedEmail,
        error,
      });

      if (createdAuthUser) {
        try {
          await admin.auth().deleteUser(user.uid);
        } catch (rollbackError) {
          console.error("Failed to roll back created admin auth user", {
            uid: user.uid,
            email: normalizedEmail,
            error: rollbackError,
          });
        }
      }

      jsonResponse(res, 500, {
        error: `Unable to write admin profile: ${
          error instanceof Error ? error.message : "Unknown Firestore error."
        }`,
      });
      return;
    }

    jsonResponse(res, 200, {
      ok: true,
      uid: user.uid,
      email: normalizedEmail,
      admin: true,
      adminType: normalizedAdminType,
    });
  } catch (error) {
    console.error("Failed to create admin user", error);
    if (authErrorResponse(error, res, "Unable to create admin user.")) {
      return;
    }

    jsonResponse(res, 500, { error: "Unable to create admin user." });
  }
});
