const crypto = require("crypto");
const admin = require("firebase-admin");
const { shouldSendPushToUser } = require("./notificationPreferences.util");

function tokenDocId(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizePlatform(platform) {
  return ["android", "ios"].includes(platform) ? platform : "unknown";
}

async function sendNotificationToUser(
  { uid, title, body, data = {}, imageUrl = null, persist = true, push = true },
  adminClient = admin,
) {
  if (!uid || !title || !body) return { successCount: 0, failureCount: 0 };

  const db = adminClient.firestore();
  const normalizedImageUrl = normalizeImageUrl(imageUrl || data?.imageUrl);
  const pushImageUrl = normalizePushImageUrl(normalizedImageUrl);
  const notificationData = stringifyData(normalizedImageUrl ? { ...data, imageUrl: normalizedImageUrl } : data);
  let notificationId = null;

  if (persist !== false) {
    const notificationRef = await db
      .collection("users")
      .doc(uid)
      .collection("notifications")
      .add({
        title,
        body,
        type: notificationData.type || "general",
        data: notificationData,
        readAt: null,
        createdAt: adminClient.firestore?.FieldValue?.serverTimestamp() || new Date(),
      });
    notificationId = notificationRef.id;
  }

  if (push === false) {
    return { successCount: 0, failureCount: 0, notificationId };
  }

  const shouldSendPush = await shouldSendPushToUser({
    category: notificationData.notificationCategory,
    data: notificationData,
    uid,
  }, adminClient);
  if (!shouldSendPush) {
    return { successCount: 0, failureCount: 0, notificationId, pushSkipped: true };
  }

  const tokensSnap = await db.collection("users").doc(uid).collection("fcmTokens").where("enabled", "==", true).get();

  const tokenDocs = tokensSnap.docs
    .map((doc) => ({ ref: doc.ref, token: doc.data()?.token }))
    .filter((doc) => typeof doc.token === "string" && doc.token.length > 0);

  if (tokenDocs.length === 0) {
    return { successCount: 0, failureCount: 0, notificationId };
  }

  const payloadData = notificationId ? { ...notificationData, notificationId } : notificationData;
  const payload = {
    tokens: tokenDocs.map((doc) => doc.token),
    notification: { title, body },
    data: payloadData,
    android: {
      priority: "high",
      notification: {
        sound: "default",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
  };

  if (pushImageUrl) {
    payload.notification.imageUrl = pushImageUrl;
    payload.android.notification.imageUrl = pushImageUrl;
    payload.apns.headers = {
      "mutable-content": "1",
    };
    payload.apns.payload.aps["mutable-content"] = 1;
    payload.apns.fcmOptions = {
      imageUrl: pushImageUrl,
    };
  }

  const response = await adminClient.messaging().sendEachForMulticast(payload);
  const cleanup = [];

  response.responses.forEach((result, index) => {
    if (!result.success && isInvalidTokenError(result.error)) {
      cleanup.push(tokenDocs[index].ref.delete());
    }
  });

  if (cleanup.length > 0) {
    await Promise.allSettled(cleanup);
  }

  return {
    successCount: response.successCount,
    failureCount: response.failureCount,
    notificationId,
  };
}

function stringifyData(data) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
}

function normalizeImageUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePushImageUrl(value) {
  const normalized = normalizeImageUrl(value);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    return ["http:", "https:"].includes(url.protocol) ? normalized : null;
  } catch (_) {
    return null;
  }
}

function firstListingImageUrl(listing = {}) {
  const images = Array.isArray(listing?.images) ? listing.images : [];
  const showcase = Array.isArray(listing?.showcase) ? listing.showcase : [];
  return [...images, ...showcase].map(normalizeImageUrl).find(Boolean) || null;
}

function isInvalidTokenError(error) {
  const code = error?.code;
  return code === "messaging/invalid-registration-token" || code === "messaging/registration-token-not-registered";
}

module.exports = {
  tokenDocId,
  normalizePlatform,
  firstListingImageUrl,
  sendNotificationToUser,
  _test: {
    firstListingImageUrl,
    normalizeImageUrl,
    normalizePushImageUrl,
    stringifyData,
    isInvalidTokenError,
  },
};
