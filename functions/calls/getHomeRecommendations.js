const admin = require("firebase-admin");
const { getHomeRail } = require("./homeRecommendations.shared.js");

/**
 * Backward-compatible combined endpoint for older clients. It returns both
 * home rails and reports the first non-empty scope used by either rail.
 */
exports.getHomeRecommendations = async (request) => {
  const recommended = await getHomeRail(request, "recommended");
  const popular = await getHomeRail(request, "popular");

  return {
    recommended: recommended.items,
    popular: popular.items,
    scopeUsed: recommended.scopeUsed !== "none" ? recommended.scopeUsed : popular.scopeUsed,
    generatedAt: admin.firestore?.Timestamp?.now().toMillis() || new Date().getTime(),
  };
};
