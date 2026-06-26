const admin = require("firebase-admin");
const geofire = require("geofire-common");

const FEED_TTL_MS = 60 * 60 * 1000;
const FEED_LIMIT = 36;
const NEARBY_RADIUS_KM = 25;
const FALLBACK_THRESHOLD = 12;

function normalizeLocationPart(value) {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
    : "";
}

function normalizeCurrencyCode(value) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return normalized || "PHP";
}

function normalizeLocationInput(location = {}) {
  const country = typeof location.country === "string" ? location.country.trim() : "";
  const locality =
    typeof location.locality === "string"
      ? location.locality.trim()
      : typeof location.cityState === "string"
        ? location.cityState.trim()
        : "";
  const lat = typeof location.lat === "number" ? location.lat : Number(location.lat);
  const lng = typeof location.lng === "number" ? location.lng : Number(location.lng);
  const countryKey = normalizeLocationPart(location.countryKey || country);
  const localityKey = normalizeLocationPart(location.localityKey || location.cityKey || locality);
  const geohash = typeof location.geohash === "string" ? location.geohash.trim() : "";
  const currencyCode = normalizeCurrencyCode(location.currencyCode);

  return {
    country,
    locality,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    geohash,
    countryKey,
    localityKey,
    cityState: locality,
    cityKey: localityKey,
    currencyCode,
  };
}

function feedId({ type, scope, location, category }) {
  const categoryKey = normalizeLocationPart(category || "all");
  if (scope === "locality" && location.localityKey) {
    return `${type}_locality:${location.countryKey}:${location.localityKey}:${location.currencyCode}:${categoryKey}`;
  }
  return `${type}_country:${location.countryKey}:${location.currencyCode}:${categoryKey}`;
}

function candidateFeedId({ scope, location }) {
  return feedId({
    type: "candidate",
    scope,
    location,
    category: "all",
  });
}

function isFeedFresh(feed, nowMs = Date.now()) {
  const generatedAt = feed?.generatedAt?.toMillis?.() || 0;
  return generatedAt > 0 && nowMs - generatedAt < FEED_TTL_MS;
}

function hasCoordinates(location) {
  return Number.isFinite(location?.lat) && Number.isFinite(location?.lng);
}

function normalizeCategoryHints(categoryHints) {
  return Array.isArray(categoryHints)
    ? categoryHints.filter((item) => typeof item === "string" && item.trim()).slice(0, 5)
    : [];
}

function toAssetPreview(doc) {
  const data = doc.data() || {};
  return {
    id: data.id || doc.id,
    ownerId: data.ownerId || null,
    title: data.title || null,
    category: data.category || null,
    rates: data.rates || null,
    images: Array.isArray(data.images) ? data.images.slice(0, 3) : [],
    location: data.location || null,
    createdAt: data.createdAt || null,
    status: data.status || null,
    isDeleted: data.isDeleted === true,
    averageRating: typeof data.averageRating === "number" ? data.averageRating : null,
    reviewCount: typeof data.reviewCount === "number" ? data.reviewCount : null,
    suppressFromRecommendations: data.suppressFromRecommendations === true,
    popularityScore: Number(data.popularityScore || 0),
    qualityScore: Number(data.qualityScore || 0),
    recommendationScore: Number(data.recommendationScore || 0),
  };
}

async function readOrRefreshCandidateFeed(db, { location, scope }) {
  const id = candidateFeedId({ scope, location });
  const feedRef = db.collection("recommendationFeeds").doc(id);
  const feedSnap = await feedRef.get();

  if (feedSnap.exists && isFeedFresh(feedSnap.data())) {
    return Array.isArray(feedSnap.data().items) ? feedSnap.data().items : [];
  }

  const items = await buildCandidateFeed(db, { location, scope });
  await feedRef.set(
    {
      id,
      type: "candidate",
      scope,
      countryKey: location.countryKey,
      localityKey: scope === "locality" ? location.localityKey : null,
      currencyCode: location.currencyCode,
      items,
      generatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    },
    { merge: true },
  );

  return items;
}

/**
 * Loads neutral candidate pools for personalized ranking. Candidate feeds are
 * intentionally not keyed by the user's category hints; personalization happens
 * after candidate retrieval using the user's recommendation profile.
 *
 * Simple version for Recommended:
 * - This only gathers possible assets by location.
 * - It does not decide what the user likes yet.
 * - After this returns, rankPersonalizedRecommendations scores candidates
 *   using the user's category preferences.
 */
async function loadCandidateSources(db, { location }) {
  const nearbyFeed = hasCoordinates(location) ? await buildNearbyAssets(db, { location }) : [];

  const localityFeed =
    location.countryKey && location.localityKey
      ? await readOrRefreshCandidateFeed(db, { location, scope: "locality" })
      : null;

  const countryFeed = location.countryKey ? await readOrRefreshCandidateFeed(db, { location, scope: "country" }) : [];

  const feeds = [nearbyFeed];
  if (nearbyFeed.length < FALLBACK_THRESHOLD) {
    feeds.push(localityFeed, countryFeed);
  }

  return {
    items: mergeFeeds(feeds),
    scopeUsed: scopeUsedFromFeeds({ nearbyFeed, localityFeed, hasCountry: Boolean(location.countryKey) }),
  };
}

function scopeUsedFromFeeds({ nearbyFeed, localityFeed, hasCountry }) {
  if (nearbyFeed.length) return "nearby";
  if (localityFeed && localityFeed.length) return "locality";
  return hasCountry ? "country" : "none";
}

function mergeFeeds(feeds) {
  const seen = new Set();
  const merged = [];

  for (const feed of feeds) {
    for (const item of feed || []) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
  }

  return merged;
}

async function buildScopedAssetFeed(db, { location, scope }) {
  const snapshot = await scopedAssetQuery(db, { location, scope }).orderBy("createdAt", "desc").limit(FEED_LIMIT).get();
  return snapshot.docs.map(toAssetPreview);
}

async function buildCandidateFeed(db, { location, scope }) {
  const snapshot = await scopedAssetQuery(db, { location, scope }).orderBy("createdAt", "desc").limit(FEED_LIMIT).get();
  return snapshot.docs
    .map(toAssetPreview)
    .filter(
      (asset) =>
        asset.id && !asset.isDeleted && asset.status === "Available" && asset.suppressFromRecommendations !== true,
    );
}

function scopedAssetQuery(db, { location, scope }) {
  let query = db
    .collection("assets")
    .where("isDeleted", "==", false)
      .where("status", "==", "Available")
      .where("rates.currency", "==", location.currencyCode)
      .where("location.country", "==", location.country);

  if (scope === "locality" && location.locality) {
    query = query.where("location.locality", "==", location.locality);
  }

  return query;
}

async function buildNearbyAssets(db, { location }) {
  const center = [location.lat, location.lng];
  const radiusInM = NEARBY_RADIUS_KM * 1000;
  const bounds = geofire.geohashQueryBounds(center, radiusInM);
  const snapshots = await Promise.all(
    bounds.map(([start, end]) =>
      db
        .collection("assets")
        .where("isDeleted", "==", false)
        .where("status", "==", "Available")
        .where("rates.currency", "==", location.currencyCode)
        .orderBy("location.geohash")
        .startAt(start)
        .endAt(end)
        .get(),
    ),
  );
  const assetsById = new Map();

  for (const snapshot of snapshots) {
    for (const doc of snapshot.docs) {
      const asset = toAssetPreview(doc);
      if (asset.rates?.currency !== location.currencyCode) continue;
      const assetLat = Number(asset.location?.lat);
      const assetLng = Number(asset.location?.lng);
      if (!Number.isFinite(assetLat) || !Number.isFinite(assetLng)) continue;

      const distanceInKm = geofire.distanceBetween(center, [assetLat, assetLng]);
      if (distanceInKm > NEARBY_RADIUS_KM) continue;

      assetsById.set(asset.id, {
        ...asset,
        distanceFromCenterInKm: distanceInKm,
      });
    }
  }

  return [...assetsById.values()].sort((a, b) => (a.distanceFromCenterInKm || 0) - (b.distanceFromCenterInKm || 0));
}

module.exports = {
  FEED_LIMIT,
  FALLBACK_THRESHOLD,
  NEARBY_RADIUS_KM,
  buildNearbyAssets,
  buildScopedAssetFeed,
  candidateFeedId,
  feedId,
  hasCoordinates,
  isFeedFresh,
  loadCandidateSources,
  mergeFeeds,
  normalizeCategoryHints,
  normalizeLocationInput,
  normalizeLocationPart,
  scopeUsedFromFeeds,
  toAssetPreview,
};
