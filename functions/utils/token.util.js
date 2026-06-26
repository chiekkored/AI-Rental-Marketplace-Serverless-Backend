const crypto = require("crypto");
const functions = require("firebase-functions");

function getQrSecret() {
  const secret = process.env.QR_SECRET;
  if (!secret) {
    throw new functions.https.HttpsError("failed-precondition", "QR secret is not configured");
  }
  return secret;
}

exports.createSignedToken = (payload) => {
  try {
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    const sig = crypto.createHmac("sha256", getQrSecret()).update(payloadB64).digest("hex");

    return `${payloadB64}.${sig}`;
  } catch (error) {
    console.error("Failed to create signed token:", error);
    throw new functions.https.HttpsError("internal", "Failed to generate signed token", error.message);
  }
};

exports.validateSignedQrToken = ({ token, nowMs = Date.now() }) => {
  if (!token) {
    throw new functions.https.HttpsError("invalid-argument", "Token is required");
  }

  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) {
    throw new functions.https.HttpsError("invalid-argument", "Malformed token");
  }

  const expectedSig = crypto.createHmac("sha256", getQrSecret()).update(payloadB64).digest("hex");
  const expected = Buffer.from(expectedSig);
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new functions.https.HttpsError("permission-denied", "Invalid token signature");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64").toString());
  } catch (error) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid token payload", error.message);
  }

  const { bookingId, userId, assetId, action, uuid, expiresAt } = payload;
  if (!bookingId || !userId || !assetId || !action || !uuid) {
    throw new functions.https.HttpsError("invalid-argument", "Missing token fields");
  }

  if (expiresAt && nowMs > expiresAt) {
    throw new functions.https.HttpsError("deadline-exceeded", "QR token expired");
  }

  return {
    payload,
    payloadB64,
    sig,
    nowMs,
  };
};
