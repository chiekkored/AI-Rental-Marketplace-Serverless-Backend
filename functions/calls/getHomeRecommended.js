const { getHomeRail } = require("./homeRecommendations.shared.js");

/**
 * Returns only the personalized Recommended rail. The rail is personalized
 * from the user's recommendation profile and candidate assets near the active
 * location, falling back to locality/country candidates only when nearby is
 * sparse.
 */
exports.getHomeRecommended = async (request) => {
  return getHomeRail(request, "recommended");
};
