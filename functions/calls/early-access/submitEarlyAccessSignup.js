const admin = require("firebase-admin");
const {
  EARLY_ACCESS_COLLECTION,
  EARLY_ACCESS_RATE_LIMIT_COLLECTION,
  EARLY_ACCESS_SOURCE,
  getRequestIp,
  hashEarlyAccessValue,
  nextRateLimitState,
  normalizeEarlyAccessEmail,
} = require("./earlyAccessSignup.util");

async function submitEarlyAccessSignup(request) {
  const email = normalizeEarlyAccessEmail(request.data?.email);
  const emailHash = hashEarlyAccessValue(email);
  const ipHash = hashEarlyAccessValue(getRequestIp(request.rawRequest));
  const db = request._testDb || admin.firestore();
  const signupRef = db.collection(EARLY_ACCESS_COLLECTION).doc(emailHash);
  const rateLimitRef = db
    .collection(EARLY_ACCESS_RATE_LIMIT_COLLECTION)
    .doc(ipHash);

  await db.runTransaction(async (transaction) => {
    const signupSnapshot = await transaction.get(signupRef);

    if (signupSnapshot.exists) {
      return;
    }

    const now = Date.now();
    const timestamp = request._testTimestampFromMillis
      ? request._testTimestampFromMillis(now)
      : admin.firestore.Timestamp?.fromMillis
      ? admin.firestore.Timestamp.fromMillis(now)
      : new Date(now);
    const rateLimitSnapshot = await transaction.get(rateLimitRef);
    const rateLimit = nextRateLimitState(rateLimitSnapshot.data(), now);

    transaction.set(signupRef, {
      createdAt: timestamp,
      email,
      emailHash,
      emailedAt: null,
      emailedBy: null,
      source: EARLY_ACCESS_SOURCE,
      status: "Pending",
    });
    transaction.set(
      rateLimitRef,
      {
        attemptCount: rateLimit.attemptCount,
        updatedAt: timestamp,
        windowStartedAt: rateLimit.resetWindow
          ? timestamp
          : rateLimitSnapshot.data()?.windowStartedAt || timestamp,
      },
      { merge: true },
    );
  });

  return { success: true };
}

module.exports = {
  submitEarlyAccessSignup,
};
