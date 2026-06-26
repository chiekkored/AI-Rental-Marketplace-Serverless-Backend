const admin = require("firebase-admin");
const { countPendingBookings } = require("../utils/pendingBookingCount.util");

const shouldWrite = process.env.RUN_BACKFILL === "true";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

async function main() {
  const db = admin.firestore();
  const assetsSnap = await db.collection("assets").get();

  let scanned = 0;
  let skipped = 0;
  let matched = 0;

  for (const assetDoc of assetsSnap.docs) {
    scanned++;
    const asset = assetDoc.data();
    const ownerId = asset.ownerId || asset.owner?.uid;

    if (!ownerId) {
      skipped++;
      console.warn(`Skipping assets/${assetDoc.id}: missing ownerId`);
      continue;
    }

    const bookingsSnap = await assetDoc.ref.collection("bookings").get();
    const pendingBookingCount = countPendingBookings(
      bookingsSnap.docs.map((doc) => doc.data()),
    );
    const ownerAssetRef = db.doc(`users/${ownerId}/assets/${assetDoc.id}`);
    matched++;

    console.log(
      `${shouldWrite ? "Updating" : "Would update"} ${ownerAssetRef.path}: ` +
        `pendingBookingCount=${pendingBookingCount}`,
    );

    if (shouldWrite) {
      await ownerAssetRef.set({ pendingBookingCount }, { merge: true });
    }
  }

  console.log(
    `Pending booking count backfill complete. scanned=${scanned}, ` +
      `matched=${matched}, skipped=${skipped}, dryRun=${!shouldWrite}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
