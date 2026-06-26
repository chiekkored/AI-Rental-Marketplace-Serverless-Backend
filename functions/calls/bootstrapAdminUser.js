const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { jsonResponse, splitDisplayName } = require("../utils/adminUser.util");

const setCorsHeaders = (res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
};

exports.bootstrapAdminUser = onRequest({ cors: true }, async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method !== "POST") {
    jsonResponse(res, 405, { error: "Method not allowed." });
    return;
  }

  const expectedSecret = process.env.ADMIN_BOOTSTRAP_SECRET;
  if (!expectedSecret) {
    jsonResponse(res, 500, { error: "Bootstrap secret is not configured." });
    return;
  }

  const { email, password, displayName, setupSecret, adminType } = req.body ?? {};

  if (setupSecret !== expectedSecret) {
    jsonResponse(res, 403, { error: "Invalid setup secret." });
    return;
  }

  if (typeof email !== "string" || !email.trim()) {
    jsonResponse(res, 400, { error: "Email is required." });
    return;
  }

  if (typeof password !== "string" || password.length < 7) {
    jsonResponse(res, 400, { error: "Password must be at least 7 characters." });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedAdminType =
    typeof adminType === "string" && adminType.trim() ? adminType.trim().toLowerCase() : "superadmin";

  if (!["superadmin", "admin", "moderator", "finance"].includes(normalizedAdminType)) {
    jsonResponse(res, 400, { error: "Invalid admin type." });
    return;
  }

  try {
    let user;
    try {
      user = await admin.auth().getUserByEmail(normalizedEmail);
    } catch (error) {
      if (error.code !== "auth/user-not-found") {
        throw error;
      }

      const createPayload = {
        email: normalizedEmail,
        password,
        emailVerified: true,
      };
      if (typeof displayName === "string" && displayName.trim()) {
        createPayload.displayName = displayName.trim();
      }

      user = await admin.auth().createUser(createPayload);
    }

    const existingClaims = user.customClaims ?? {};
    await admin.auth().setCustomUserClaims(user.uid, {
      ...existingClaims,
      admin: true,
      adminType: normalizedAdminType,
    });

    const adminUserRef = admin.firestore().collection("adminUsers").doc(user.uid);
    const adminUserSnap = await adminUserRef.get();
    const { firstName, lastName } = splitDisplayName(typeof displayName === "string" ? displayName.trim() : "");

    await adminUserRef.set(
      {
        uid: user.uid,
        email: normalizedEmail,
        firstName,
        lastName,
        displayName:
          typeof displayName === "string" && displayName.trim() ? displayName.trim() : (user.displayName ?? null),
        photoUrl: user.photoURL ?? null,
        createdAt:
          adminUserSnap.exists && adminUserSnap.data()?.createdAt
            ? adminUserSnap.data().createdAt
            : admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        adminType: normalizedAdminType,
        status: "Active",
        createdBy: adminUserSnap.data()?.createdBy ?? "bootstrap",
        updatedBy: "bootstrap",
        deletedAt: null,
        deletedBy: null,
      },
      { merge: true },
    );

    jsonResponse(res, 200, {
      ok: true,
      uid: user.uid,
      email: normalizedEmail,
      admin: true,
      adminType: normalizedAdminType,
    });
  } catch (error) {
    console.error("Failed to bootstrap admin user", error);
    jsonResponse(res, 500, { error: "Unable to bootstrap admin user." });
  }
});
