const crypto = require("crypto");
const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  getEmailVerificationBaseUrl,
  normalizeEmail,
  resolveTransactionalEmailEnabled,
  sendTransactionalEmail,
} = require("../utils/email.util");
const { buildEmailVerificationEmail } = require("../utils/transactionalEmailTemplates.util");

const EMAIL_VERIFICATION_TOKENS_COLLECTION = "emailVerificationTokens";
const EMAIL_VERIFICATION_RATE_LIMIT_COLLECTION = "emailVerificationRateLimits";
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

async function requestEmailVerification(request) {
  try {
    if (!request.auth?.uid) {
      throwAndLogHttpsError("permission-denied", "User must be authenticated");
    }

    const uid = request.auth.uid;
    const db = request._testDb || admin.firestore();
    const authClient = request._testAuth || admin.auth();
    const user = await authClient.getUser(uid);
    const email = normalizeEmail(user.email);

    if (!email) {
      throwAndLogHttpsError("failed-precondition", "Account email is missing");
    }

    const transactionalEmailEnabled = await resolveTransactionalEmailEnabled({
      adminClient: request._testRemoteConfigAdmin || request._testAdmin || admin,
      override: request._testTransactionalEmailEnabled,
    });
    if (!transactionalEmailEnabled) {
      await autoVerifyEmailUser({ authClient, db, uid });
      return { autoVerified: true, emailSent: false, success: true };
    }

    if (user.emailVerified === true) {
      return { alreadyVerified: true, autoVerified: false, emailSent: false, success: true };
    }

    const nowMs = Date.now();
    await assertRateLimit({ db, nowMs, uid });

    const token = createVerificationToken();
    const tokenHash = hashVerificationToken(token);
    const tokenRef = db.collection(EMAIL_VERIFICATION_TOKENS_COLLECTION).doc(tokenHash);
    const timestamp = timestampFromMillis(nowMs, request);
    const expiresAt = timestampFromMillis(nowMs + TOKEN_TTL_MS, request);
    const link = buildVerificationLink(token, request._testEnv || process.env);
    const emailPayload = buildEmailVerificationEmail({ link, recipientName: user.displayName });

    await tokenRef.create({
      consumedAt: null,
      createdAt: timestamp,
      email,
      expiresAt,
      expiresAtMs: nowMs + TOKEN_TTL_MS,
      tokenHash,
      uid,
    });

    const sendResult = await sendTransactionalEmail(
      {
        idempotencyKey: `email-verification:${uid}:${tokenHash}`,
        html: emailPayload.html,
        subject: emailPayload.subject,
        tag: "email_verification",
        text: emailPayload.text,
        to: email,
      },
      {
        adminClient: request._testAdmin || admin,
        env: request._testEnv || process.env,
        resendClient: request._testResend,
        transactionalEmailEnabled: true,
      },
    );

    return { autoVerified: false, emailSent: sendResult.sent === true, success: true };
  } catch (error) {
    if (error?.code) throw error;
    console.error(`[requestEmailVerification] Error: ${error.message}`);
    throwAndLogHttpsError("internal", "Unable to request email verification");
  }
}

async function autoVerifyEmailUser({ authClient, db, uid }) {
  await authClient.updateUser(uid, { emailVerified: true });

  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);
    const userData = snapshot.data() || {};
    const verificationLevel = userData.verified;
    if (verificationLevel === "Basic" || verificationLevel === "Full") return;

    const currentVersion = Number(userData.userMetadataVersion);
    transaction.set(
      userRef,
      {
        userMetadataVersion: Number.isFinite(currentVersion) ? currentVersion + 1 : 1,
        verified: "Basic",
      },
      { merge: true },
    );
  });
}

async function verifyEmail(request, response) {
  setCorsHeaders(response);
  if (request.method === "OPTIONS") {
    response.status(204).send("");
    return;
  }

  if (request.method !== "POST") {
    response.status(405).json({ code: "method_not_allowed", success: false });
    return;
  }

  try {
    const token = typeof request.body?.token === "string" ? request.body.token.trim() : "";
    const result = await verifyEmailToken({ token });
    response.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error(`[verifyEmail] Error: ${error.message}`);
    response.status(500).json({ code: "internal", success: false });
  }
}

async function verifyEmailToken({ token, adminClient = admin, nowMs = Date.now() }) {
  if (!token) return { code: "invalid", success: false };

  const tokenHash = hashVerificationToken(token);
  const db = adminClient.firestore();
  const authClient = adminClient.auth();
  const tokenRef = db.collection(EMAIL_VERIFICATION_TOKENS_COLLECTION).doc(tokenHash);
  let tokenData = null;

  const result = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(tokenRef);
    if (!snap.exists) return { code: "invalid", success: false };

    tokenData = snap.data();
    if (tokenData?.consumedAt) return { code: "consumed", success: false };
    if (Number(tokenData?.expiresAtMs || 0) <= nowMs) return { code: "expired", success: false };

    const user = await authClient.getUser(tokenData.uid);
    if (normalizeEmail(user.email) !== normalizeEmail(tokenData.email)) {
      return { code: "email_mismatch", success: false };
    }

    transaction.set(
      tokenRef,
      {
        consumedAt: adminClient.firestore.FieldValue?.serverTimestamp() || new Date(),
      },
      { merge: true },
    );
    return { success: true, uid: tokenData.uid };
  });

  if (!result.success) return result;

  await authClient.updateUser(tokenData.uid, { emailVerified: true });
  return { success: true };
}

async function assertRateLimit({ db, nowMs, uid }) {
  const ref = db.collection(EMAIL_VERIFICATION_RATE_LIMIT_COLLECTION).doc(uid);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const current = snap.data() || {};
    const windowStartedAtMs = Number(current.windowStartedAtMs || 0);
    const lastAttemptAtMs = Number(current.lastAttemptAtMs || 0);
    const resetWindow = !windowStartedAtMs || nowMs - windowStartedAtMs >= RATE_LIMIT_WINDOW_MS;
    const attemptCount = resetWindow ? 0 : Number(current.attemptCount || 0);

    if (!resetWindow && nowMs - lastAttemptAtMs < RATE_LIMIT_COOLDOWN_MS) {
      throwAndLogHttpsError("resource-exhausted", "Wait before requesting another verification email");
    }

    if (attemptCount >= RATE_LIMIT_MAX_ATTEMPTS) {
      throwAndLogHttpsError("resource-exhausted", "Too many verification email requests");
    }

    transaction.set(
      ref,
      {
        attemptCount: attemptCount + 1,
        lastAttemptAtMs: nowMs,
        updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        windowStartedAtMs: resetWindow ? nowMs : windowStartedAtMs,
      },
      { merge: true },
    );
  });
}

function buildVerificationLink(token, env = process.env) {
  const base = getEmailVerificationBaseUrl(env);
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}token=${encodeURIComponent(token)}`;
}

function createVerificationToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashVerificationToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function timestampFromMillis(ms, request) {
  return request._testTimestampFromMillis
    ? request._testTimestampFromMillis(ms)
    : admin.firestore.Timestamp?.fromMillis
    ? admin.firestore.Timestamp.fromMillis(ms)
    : new Date(ms);
}

function setCorsHeaders(response) {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Headers", "Content-Type");
  response.set("Access-Control-Allow-Methods", "POST, OPTIONS");
}

module.exports = {
  EMAIL_VERIFICATION_RATE_LIMIT_COLLECTION,
  EMAIL_VERIFICATION_TOKENS_COLLECTION,
  RATE_LIMIT_MAX_ATTEMPTS,
  requestEmailVerification,
  verifyEmail,
  verifyEmailToken,
  _test: {
    buildVerificationLink,
    createVerificationToken,
    hashVerificationToken,
    autoVerifyEmailUser,
  },
};
