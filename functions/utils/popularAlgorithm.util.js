const admin = require("firebase-admin");

const {
  FEED_LIMIT,
  FALLBACK_THRESHOLD,
  buildNearbyAssets,
  buildScopedAssetFeed,
  feedId,
  hasCoordinates,
  isFeedFresh,
  mergeFeeds,
  scopeUsedFromFeeds,
} = require("./feedAlgorithm.util");

/**
 * Scores non-personalized home rail items.
 *
 * Simple version for Popular:
 * - An asset can show only after rankAndDedupe passes the hard filters:
 *   it has an id, belongs to someone else, is not deleted, is Available, and is
 *   not suppressed from recommendations.
 * - Then we add three numbers. Bigger total wins.
 *    - **popularityScore**: a stored marketplace signal for general demand or
 *   performance. Higher means the asset is doing better overall.
 *    - **qualityScore**: a quality signal from reviews/ratings. For this generic
 *   score, unrated assets still get 2.5 so they are not buried immediately.
 *    - **recommendationScore**: a stored marketplace signal for generic
 *   recommendation strength.
 *    - **categoryBoost**: a fixed +8 bonus when the asset category matches a provided
 *   category hint.
 *
 * Popular ranking favors marketplace popularity, quality, and light freshness:
 *   popularityScore + qualityScore + freshnessBoost
 *
 * Generic recommendation ranking, retained for non-personalized/feed reuse,
 * favors marketplace recommendation score, quality, matching category hints,
 * and light freshness:
 *   recommendationScore + qualityScore + categoryBoost + freshnessBoost
 *
 * Quality falls back to 2.5 for unrated assets so new unrated listings can
 * still appear instead of being completely buried.
 *
 * Freshness is a small bonus. A newer asset gets more of it; an older asset
 * slowly loses it. This helps fresh listings appear without letting age beat
 * strong popularity or quality.
 */
function scoreAsset(asset, { categoryHints = [], type }) {
  const reviewCount = Number(asset.reviewCount || 0);
  const averageRating = Number(asset.averageRating || 0);
  const qualityScore = reviewCount > 0 ? averageRating * Math.min(reviewCount, 10) : 2.5;
  const popularityScore = Number(asset.popularityScore || 0);
  const categoryBoost = categoryHints.includes(asset.categoryId) ? 8 : 0;
  const createdAtMs = asset.createdAt?.toMillis?.() || 0;
  const ageDays = createdAtMs > 0 ? (Date.now() - createdAtMs) / 86400000 : 365;
  const freshnessBoost = Math.max(0, 4 - ageDays / 14);

  if (type === "popular") {
    return popularityScore + qualityScore + freshnessBoost;
  }

  return Number(asset.recommendationScore || 0) + qualityScore + categoryBoost + freshnessBoost;
}

/**
 * Ranks and filters a non-personalized feed. This is used by popular and by
 * cached/generated feed documents, so the same current-user exclusion,
 * availability checks, suppression checks, score ordering, and owner diversity
 * cap are applied whether the source is nearby search or Firestore feed cache.
 *
 * Simple version:
 * 1. Throw away assets that should never show.
 * 2. Give every remaining asset a score.
 * 3. Sort by score, highest first.
 * 4. Keep at most three assets from the same owner.
 * 5. Keep only FEED_LIMIT assets for cache/feed reuse.
 */
function rankAndDedupe(assets, options) {
  const ownerCounts = new Map();
  const currentUserId = options?.currentUserId;
  const excludedOwnerIds = options?.excludedOwnerIds || new Set();
  return assets
    .filter(
      (asset) =>
        asset.id &&
        asset.ownerId !== currentUserId &&
        !excludedOwnerIds.has(asset.ownerId) &&
        !asset.isDeleted &&
        asset.status === "Available" &&
        asset.suppressFromRecommendations !== true,
    )
    .map((asset) => ({ asset, score: scoreAsset(asset, options) }))
    .sort((a, b) => b.score - a.score)
    .filter(({ asset }) => {
      const ownerId = asset.ownerId || "unknown";
      const count = ownerCounts.get(ownerId) || 0;
      if (count >= 3) return false;
      ownerCounts.set(ownerId, count + 1);
      return true;
    })
    .slice(0, FEED_LIMIT)
    .map(({ asset }) => asset);
}

async function readRankedNearbyFeed(db, { type, location, categoryHints, currentUserId }) {
  const assets = await buildNearbyAssets(db, { location });
  return rankAndDedupe(assets, { categoryHints, currentUserId, type });
}

async function readOrRefreshRankedFeed(db, { type, location, categoryHints, currentUserId, scope }) {
  const id = feedId({
    type,
    scope,
    location,
    category: type === "recommended" ? categoryHints[0] : "all",
  });
  const feedRef = db.collection("recommendationFeeds").doc(id);
  const feedSnap = await feedRef.get();

  if (feedSnap.exists && isFeedFresh(feedSnap.data())) {
    const items = Array.isArray(feedSnap.data().items) ? feedSnap.data().items : [];
    return rankAndDedupe(items, { categoryHints, currentUserId, type });
  }

  const items = await buildScopedAssetFeed(db, { location, scope });
  await feedRef.set(
    {
      id,
      type,
      scope,
      countryKey: location.countryKey,
      localityKey: scope === "locality" ? location.localityKey : null,
      currencyCode: location.currencyCode,
      categoryHints,
      items,
      generatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    },
    { merge: true },
  );

  return rankAndDedupe(items, { categoryHints, currentUserId, type });
}

/**
 * Loads a non-personalized rail in source priority order. Nearby results are
 * always tried first when coordinates exist. Locality and country feeds are
 * read to preserve the existing cache refresh behavior, but they are merged
 * into the returned rail only when nearby has fewer than FALLBACK_THRESHOLD
 * items.
 *
 * Simple version for Popular:
 * - Prefer closest assets.
 * - If there are not enough close assets, widen to city/locality.
 * - If still sparse, widen to country.
 * - Merge in that order so closer assets stay ahead when scores already chose
 *   the order inside each source.
 */
async function loadRankedRailSources(db, { type, location, categoryHints, currentUserId }) {
  const nearbyFeed = hasCoordinates(location)
    ? await readRankedNearbyFeed(db, { type, location, categoryHints, currentUserId })
    : [];

  const localityFeed =
    location.countryKey && location.localityKey
      ? await readOrRefreshRankedFeed(db, {
          type,
          location,
          categoryHints,
          currentUserId,
          scope: "locality",
        })
      : null;

  const countryFeed = location.countryKey
    ? await readOrRefreshRankedFeed(db, {
        type,
        location,
        categoryHints,
        currentUserId,
        scope: "country",
      })
    : [];

  const feeds = [nearbyFeed];
  if (nearbyFeed.length < FALLBACK_THRESHOLD) {
    feeds.push(localityFeed, countryFeed);
  }

  return {
    items: mergeFeeds(feeds),
    scopeUsed: scopeUsedFromFeeds({ nearbyFeed, localityFeed, hasCountry: Boolean(location.countryKey) }),
  };
}

module.exports = {
  loadRankedRailSources,
  rankAndDedupe,
  readOrRefreshRankedFeed,
  readRankedNearbyFeed,
  scoreAsset,
};
