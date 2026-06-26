const admin = require("firebase-admin");
const geofire = require("geofire-common");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

const db = admin.firestore();

async function main() {
  const assetsSnap = await db.collection("assets").get();
  let updated = 0;
  let skipped = 0;

  for (const assetDoc of assetsSnap.docs) {
    const asset = assetDoc.data() || {};
    const nextLocation = normalizeLocation(asset.location);
    if (!nextLocation) {
      skipped += 1;
      console.warn(`Skipping assets/${assetDoc.id}: no usable location`);
      continue;
    }

    const batch = db.batch();
    batch.update(assetDoc.ref, { location: nextLocation });

    const ownerId = asset.ownerId || asset.owner?.uid;
    if (ownerId) {
      const mirrorRef = db.doc(`users/${ownerId}/assets/${assetDoc.id}`);
      const mirrorSnap = await mirrorRef.get();
      if (mirrorSnap.exists) {
        batch.update(mirrorRef, { location: nextLocation });
      }
    }

    await batch.commit();
    updated += 1;
  }

  console.log(`Backfill complete. updated=${updated}, skipped=${skipped}`);
}

function normalizeLocation(location) {
  if (!location || typeof location !== "object") return null;

  const legacyGeoPoint = location.latLng;
  const lat = numberValue(location.lat ?? legacyGeoPoint?.latitude);
  const lng = numberValue(location.lng ?? legacyGeoPoint?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const formattedAddress = stringValue(location.formattedAddress || location.description);
  const locality = stringValue(location.locality || location.cityState);
  const country = stringValue(location.country);

  return removeNulls({
    plusCode: stringValue(location.plusCode),
    streetNumber: stringValue(location.streetNumber),
    route: stringValue(location.route),
    locality,
    administrativeAreaLevel2: stringValue(location.administrativeAreaLevel2),
    administrativeAreaLevel1: stringValue(location.administrativeAreaLevel1),
    country,
    countryShortName: stringValue(location.countryShortName),
    postalCode: stringValue(location.postalCode),
    formattedAddress,
    lat,
    lng,
    geohash: stringValue(location.geohash) || geofire.geohashForLocation([lat, lng]),
  });
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function removeNulls(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== null && entryValue !== undefined),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
