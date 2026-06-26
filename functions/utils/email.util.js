const crypto = require("crypto");
const admin = require("firebase-admin");
const { shouldSendOptionalEmailToUser } = require("./notificationPreferences.util");
const { getTransactionalEmailEnabledConfig } = require("./remoteConfig.util");

const EMAIL_EVENTS_COLLECTION = "emailEvents";

function normalizeEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function getResendConfig(env = process.env) {
  return {
    apiKey: trim(env.RESEND_API_KEY),
    from: trim(env.RESEND_FROM_EMAIL),
    replyTo: trim(env.RESEND_REPLY_TO_EMAIL),
  };
}

function isEmailConfigured(env = process.env) {
  const config = getResendConfig(env);
  return Boolean(config.apiKey && config.from);
}

function getEmailVerificationBaseUrl(env = process.env) {
  const explicit = trim(env.EMAIL_VERIFICATION_BASE_URL);
  if (explicit) return explicit.replace(/\?+$/, "");

  const webBase = trim(env.LEND_WEB_BASE_URL) || "https://getlend.dev";
  return `${webBase.replace(/\/+$/, "")}/email/verify`;
}

async function getUserEmail(uid, adminClient = admin) {
  if (!uid) return null;

  try {
    const user = await adminClient.auth().getUser(uid);
    const authEmail = normalizeEmail(user.email);
    if (authEmail) return authEmail;
  } catch (error) {
    console.warn(`[email] Failed to load auth user ${uid}: ${error.message}`);
  }

  const snap = await adminClient.firestore().collection("users").doc(uid).get();
  return normalizeEmail(snap.data()?.email);
}

async function sendTransactionalEmail(
  { html, idempotencyKey, subject, tag, text, to },
  { adminClient = admin, env = process.env, resendClient = null, transactionalEmailEnabled } = {},
) {
  const emailEnabled = await resolveTransactionalEmailEnabled({
    adminClient,
    override: transactionalEmailEnabled,
  });
  if (!emailEnabled) {
    return { sent: false, skipped: true, reason: "email_disabled" };
  }

  const email = normalizeEmail(to);
  if (!email || !subject || !text || !idempotencyKey) {
    return { sent: false, skipped: true, reason: "invalid_request" };
  }

  const db = adminClient.firestore();
  const eventRef = db.collection(EMAIL_EVENTS_COLLECTION).doc(hashEventKey(idempotencyKey));
  const now = adminClient.firestore?.FieldValue?.serverTimestamp() || new Date();

  try {
    await eventRef.create({
      createdAt: now,
      idempotencyKey,
      status: "pending",
      subject,
      tag: tag || null,
      to: email,
    });
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return { sent: false, skipped: true, reason: "duplicate" };
    }
    throw error;
  }

  const config = getResendConfig(env);
  if (!config.apiKey || !config.from) {
    await eventRef.set(
      {
        completedAt: now,
        status: "skipped",
        skipReason: "missing_resend_config",
      },
      { merge: true },
    );
    console.warn(`[email] Missing Resend config; skipped ${idempotencyKey}`);
    return { sent: false, skipped: true, reason: "missing_config" };
  }

  try {
    const client = resendClient || createResendClient(config.apiKey);
    const result = await client.emails.send({
      from: config.from,
      to: email,
      subject,
      html: html || textToHtml(text),
      text,
      ...(config.replyTo ? { replyTo: config.replyTo } : {}),
      ...(tag ? { tags: [{ name: "type", value: tag }] } : {}),
    });

    await eventRef.set(
      {
        completedAt: adminClient.firestore?.FieldValue?.serverTimestamp() || new Date(),
        providerId: result?.data?.id || result?.id || null,
        status: "sent",
      },
      { merge: true },
    );

    return { providerId: result?.data?.id || result?.id || null, sent: true };
  } catch (error) {
    await eventRef.set(
      {
        completedAt: adminClient.firestore?.FieldValue?.serverTimestamp() || new Date(),
        error: error.message || "Unable to send email",
        status: "failed",
      },
      { merge: true },
    );
    throw error;
  }
}

async function sendTransactionalEmailToUser({ uid, ...email }, options = {}) {
  const transactionalEmailEnabled = await resolveTransactionalEmailEnabled({
    adminClient: options.adminClient || admin,
    override: options.transactionalEmailEnabled,
  });
  if (!transactionalEmailEnabled) {
    return { sent: false, skipped: true, reason: "email_disabled" };
  }
  const emailAllowed = await shouldSendOptionalEmailToUser({
    category: options.emailCategory,
    uid,
  }, options.adminClient || admin);
  if (!emailAllowed) {
    return { sent: false, skipped: true, reason: "email_preference_disabled" };
  }
  const to = await getUserEmail(uid, options.adminClient || admin);
  if (!to) return { sent: false, skipped: true, reason: "missing_recipient" };
  return sendTransactionalEmail({ ...email, to }, { ...options, transactionalEmailEnabled });
}

async function resolveTransactionalEmailEnabled({ adminClient = admin, override } = {}) {
  if (typeof override === "boolean") return override;
  try {
    return await getTransactionalEmailEnabledConfig(adminClient);
  } catch (error) {
    console.warn(`[email] Unable to read transactional email config; email remains enabled: ${error.message}`);
    return true;
  }
}

function createResendClient(apiKey) {
  const { Resend } = require("resend");
  return new Resend(apiKey);
}

function hashEventKey(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function isAlreadyExistsError(error) {
  return error?.code === 6 || error?.code === "already-exists" || error?.code === "ALREADY_EXISTS";
}

function textToHtml(text) {
  return String(text)
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  EMAIL_EVENTS_COLLECTION,
  getEmailVerificationBaseUrl,
  getResendConfig,
  getUserEmail,
  hashEventKey,
  isEmailConfigured,
  normalizeEmail,
  resolveTransactionalEmailEnabled,
  sendTransactionalEmail,
  sendTransactionalEmailToUser,
  _test: {
    escapeHtml,
    hashEventKey,
    textToHtml,
  },
};
