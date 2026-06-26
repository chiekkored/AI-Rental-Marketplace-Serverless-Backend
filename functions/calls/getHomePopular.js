const { getHomeRail } = require("./homeRecommendations.shared.js");

/**
 * Returns only the Popular rail. Popular is not personalized, but it still
 * excludes the current user's own assets and uses the same nearby-first
 * fallback flow as the combined home endpoint.
 */
exports.getHomePopular = async (request) => {
  return getHomeRail(request, "popular");
};
