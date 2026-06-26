const crypto = require("crypto");

function getDiditConfig() {
  const runtimeConfig = safeFunctionsConfig();
  const diditConfig = runtimeConfig.didit || {};

  return {
    webhookSecretKey: process.env.DIDIT_WEBHOOK_SECRET_KEY || diditConfig.webhook_secret_key,
  };
}

function safeFunctionsConfig() {
  try {
    // Lazy require keeps utility tests simple and avoids loading functions config
    // outside the Firebase runtime unless it is available.
    return require("firebase-functions").config();
  } catch (_) {
    return {};
  }
}

function shortenFloats(data) {
  if (Array.isArray(data)) {
    return data.map(shortenFloats);
  }
  if (data !== null && typeof data === "object") {
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, shortenFloats(value)]));
  }
  if (typeof data === "number" && !Number.isInteger(data) && data % 1 === 0) {
    return Math.trunc(data);
  }
  return data;
}

function sortKeys(obj) {
  if (Array.isArray(obj)) {
    return obj.map(sortKeys);
  }
  if (obj !== null && typeof obj === "object") {
    return Object.keys(obj)
      .sort()
      .reduce((result, key) => {
        result[key] = sortKeys(obj[key]);
        return result;
      }, {});
  }
  return obj;
}

function isFreshTimestamp(timestampHeader) {
  const currentTime = Math.floor(Date.now() / 1000);
  const incomingTime = Number.parseInt(timestampHeader, 10);
  return Number.isFinite(incomingTime) && Math.abs(currentTime - incomingTime) <= 300;
}

function timingSafeEqualText(expected, actual) {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual || "", "utf8");
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function verifySignatureV2(jsonBody, signatureHeader, timestampHeader, secretKey) {
  if (!signatureHeader || !timestampHeader || !secretKey || !isFreshTimestamp(timestampHeader)) {
    return false;
  }

  const canonicalJson = JSON.stringify(sortKeys(shortenFloats(jsonBody)));
  const expectedSignature = crypto.createHmac("sha256", secretKey).update(canonicalJson, "utf8").digest("hex");
  return timingSafeEqualText(expectedSignature, signatureHeader);
}

function verifySignatureSimple(jsonBody, signatureHeader, timestampHeader, secretKey) {
  if (!signatureHeader || !timestampHeader || !secretKey || !isFreshTimestamp(timestampHeader)) {
    return false;
  }

  const canonicalString = [
    jsonBody.timestamp || "",
    jsonBody.session_id || "",
    jsonBody.status || "",
    jsonBody.webhook_type || "",
  ].join(":");
  const expectedSignature = crypto.createHmac("sha256", secretKey).update(canonicalString).digest("hex");
  return timingSafeEqualText(expectedSignature, signatureHeader);
}

module.exports = {
  getDiditConfig,
  verifySignatureSimple,
  verifySignatureV2,
};
