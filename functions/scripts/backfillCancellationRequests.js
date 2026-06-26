const admin = require("firebase-admin");

const shouldWrite = process.env.RUN_BACKFILL === "true";
const BOOKING_STATUS_CANCELLATION_REQUESTED = "Cancellation Requested";
const CHAT_STATUS_ACTIVE = "Active";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

async function main() {
  const db = admin.firestore();
  const assetBookingSnaps = await db
    .collectionGroup("bookings")
    .where("status", "==", BOOKING_STATUS_CANCELLATION_REQUESTED)
    .get();

  let scanned = 0;
  let matched = 0;
  let skipped = 0;
  let alreadySynced = 0;

  for (const assetBookingDoc of assetBookingSnaps.docs) {
    scanned++;

    if (!isAssetBookingDoc(assetBookingDoc.ref)) {
      skipped++;
      continue;
    }

    const booking = assetBookingDoc.data() || {};
    const bookingId = assetBookingDoc.id;
    const assetId = assetBookingDoc.ref.parent.parent?.id || booking.asset?.id;
    const renterId = booking.renter?.uid;
    const ownerId = booking.asset?.owner?.uid;
    const chatId = booking.chatId;

    if (!assetId || !renterId) {
      skipped++;
      console.warn(`Skipping ${assetBookingDoc.ref.path}: missing assetId or renterId`);
      continue;
    }

    const rootBookingRef = db.collection("bookings").doc(bookingId);
    const rootBookingSnap = await rootBookingRef.get();
    const rootBooking = rootBookingSnap.data() || {};

    if (
      rootBookingSnap.exists &&
      rootBooking.status === BOOKING_STATUS_CANCELLATION_REQUESTED &&
      rootBooking.cancellationRequest?.status === booking.cancellationRequest?.status
    ) {
      alreadySynced++;
      continue;
    }

    matched++;
    console.log(
      `${shouldWrite ? "Repairing" : "Would repair"} ${rootBookingRef.path} ` +
        `from ${assetBookingDoc.ref.path}`,
    );

    if (!shouldWrite) {
      continue;
    }

    const batch = db.batch();
    batch.set(rootBookingRef, { ...booking, id: bookingId, asset: { ...booking.asset, id: assetId } }, { merge: true });

    if (chatId && ownerId) {
      const chatUpdate = {
        bookingStatus: BOOKING_STATUS_CANCELLATION_REQUESTED,
        status: CHAT_STATUS_ACTIVE,
        lastUpdated: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      };
      batch.set(db.collection("userChats").doc(renterId).collection("chats").doc(chatId), chatUpdate, { merge: true });
      batch.set(db.collection("userChats").doc(ownerId).collection("chats").doc(chatId), chatUpdate, { merge: true });
    }

    await batch.commit();
  }

  console.log(
    `Cancellation request backfill complete. scanned=${scanned}, matched=${matched}, ` +
      `alreadySynced=${alreadySynced}, skipped=${skipped}, dryRun=${!shouldWrite}`,
  );
}

function isAssetBookingDoc(ref) {
  return ref.parent.parent?.parent?.id === "assets";
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

exports._test = {
  isAssetBookingDoc,
};
