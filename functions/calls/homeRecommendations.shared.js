const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const { hasCoordinates, loadCandidateSources, normalizeLocationInput } = require("../utils/feedAlgorithm.util");
const { rankPersonalizedRecommendations, recommendationProfileRef } = require("../utils/recommendedAlgorithm.util");
const { loadRankedRailSources } = require("../utils/popularAlgorithm.util");
const { loadExcludedUserIds } = require("../utils/userBlock.util");

/**
 * Home recommendation algorithm overview:
 * - Recommended is "things this user is likely to want." We first collect
 *   available assets near the user's active location, add locality/country
 *   fallback candidates if nearby is sparse, then score each candidate against
 *   the user's saved category preferences.
 * - Popular is "things generally doing well around this location." We collect
 *   nearby/locality/country assets the same way, then score them by marketplace
 *   popularity, rating quality, and freshness.
 * - Before anything can show in either feed, it must pass the hard rules:
 *   not owned by the current user, not deleted, status is Available, not
 *   suppressed from recommendations, and no owner can contribute more than
 *   three assets to the same rail.
 *
 * Shared feed plumbing lives in feed_algorithm.util.js. Recommended and popular
 * scoring live in their purpose-specific algorithm utilities.
 */

async function getHomeRail(request, type) {
  const { auth, normalizedLocation, limit } = parseHomeRailRequest(request);

  if (!normalizedLocation.countryKey && !hasCoordinates(normalizedLocation)) {
    return emptyRailResult();
  }

  const db = admin.firestore();

  if (type === "recommended") {
    return getPersonalizedRecommendedRail({
      db,
      uid: auth.uid,
      normalizedLocation,
      limit,
    });
  }

  return getPopularRail({
    db,
    uid: auth.uid,
    normalizedLocation,
    limit,
  });
}

function parseHomeRailRequest(request) {
  const auth = request.auth;
  const { location = {}, currencyCode, limitPerRail = 12 } = request.data || {};

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  return {
    auth,
    normalizedLocation: normalizeLocationInput({ ...location, currencyCode }),
    limit: Math.max(1, Math.min(Number(limitPerRail) || 12, 12)),
  };
}

function emptyRailResult() {
  return {
    items: [],
    scopeUsed: "none",
    generatedAt: null,
  };
}

async function getPersonalizedRecommendedRail({ db, uid, normalizedLocation, limit }) {
  const profileSnap = await recommendationProfileRef(db, uid).get();
  if (!profileSnap.exists) {
    return {
      items: [],
      scopeUsed: "none",
      generatedAt: admin.firestore?.Timestamp?.now().toMillis() || new Date().getTime(),
    };
  }

  // Recommended feed, simple version:
  // 1. Get assets from the active location: nearby first, then locality/country
  //    fallback if nearby does not provide enough candidates.
  // 2. Use the user's recommendation profile to ask, "does this asset category
  //    match what this user has shown interest in?"
  // 3. Score matching assets, sort highest first, apply owner diversity, then
  //    return the requested limit.
  // Candidate feeds are neutral and location-based so the same cached candidate
  // pool can be reused across users; personalization happens after loading.
  const candidates = await loadCandidateSources(db, {
    location: normalizedLocation,
  });
  const excludedOwnerIds = await loadExcludedUserIds(db, uid);
  const items = rankPersonalizedRecommendations(candidates.items, profileSnap.data(), {
    currentUserId: uid,
    excludedOwnerIds,
    limit,
  });

  return {
    items,
    scopeUsed: candidates.scopeUsed,
    generatedAt: admin.firestore?.Timestamp?.now().toMillis() || new Date().getTime(),
  };
}

async function getPopularRail({ db, uid, normalizedLocation, limit }) {
  // Popular feed, simple version:
  // 1. Get available assets from nearby first.
  // 2. If nearby has too few assets, also use locality and country assets.
  // 3. Score assets by popularity + quality + freshness, remove duplicates,
  //    apply owner diversity, then return the requested limit.
  const excludedOwnerIds = await loadExcludedUserIds(db, uid);
  const rail = await loadRankedRailSources(db, {
    type: "popular",
    location: normalizedLocation,
    categoryHints: [],
    currentUserId: uid,
    excludedOwnerIds,
  });

  return {
    items: rail.items.slice(0, limit),
    scopeUsed: rail.scopeUsed,
    generatedAt: admin.firestore?.Timestamp?.now().toMillis() || new Date().getTime(),
  };
}

module.exports = {
  emptyRailResult,
  getHomeRail,
  getPersonalizedRecommendedRail,
  getPopularRail,
  parseHomeRailRequest,
};
