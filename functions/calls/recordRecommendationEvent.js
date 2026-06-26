const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const { updateRecommendationProfile } = require("../utils/recommendations.util");

const EVENT_WEIGHTS = {
  savedAsset: 3,
  assetView: 1,
};

exports.recordRecommendationEvent = async (request) => {
  const auth = request.auth;
  const { assetId, eventType } = request.data || {};

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (!assetId || !EVENT_WEIGHTS[eventType]) {
    throwAndLogHttpsError("invalid-argument", "Missing assetId or invalid recommendation event type");
  }

  const db = admin.firestore();
  const assetRef = db.collection("assets").doc(assetId);

  await db.runTransaction(async (transaction) => {
    const assetSnap = await transaction.get(assetRef);
    if (!assetSnap.exists) {
      throwAndLogHttpsError("not-found", "Asset not found");
    }

    const asset = assetSnap.data() || {};
    if (asset.isDeleted === true || asset.status !== "Available") {
      throwAndLogHttpsError("failed-precondition", "Asset is unavailable");
    }

    if (asset.ownerId === auth.uid) {
      return;
    }

    updateRecommendationProfile(transaction, db, {
      uid: auth.uid,
      asset: {
        id: assetId,
        ownerId: asset.ownerId || null,
        categoryId: asset.categoryId || null,
        categoryName: asset.categoryName || null,
      },
      weight: EVENT_WEIGHTS[eventType],
      signalType: eventType,
    });
  });

  return { success: true };
};
