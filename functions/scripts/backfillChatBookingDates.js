const admin = require("firebase-admin");

const shouldWrite = process.env.RUN_BACKFILL === "true";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

async function main() {
  const db = admin.firestore();
  const chatSnaps = await db.collectionGroup("chats").get();

  let scanned = 0;
  let skipped = 0;
  let matched = 0;
  let alreadySet = 0;

  for (const chatDoc of chatSnaps.docs) {
    scanned++;
    const parentCollection = chatDoc.ref.parent.parent?.parent;

    if (parentCollection?.id !== "userChats") {
      skipped++;
      continue;
    }

    const chat = chatDoc.data();

    if (chat.bookingStartDate && chat.bookingEndDate) {
      alreadySet++;
      continue;
    }

    const bookingId = chat.bookingId;
    const renterId = chat.renterId;
    const assetId = chat.asset?.id;

    if (!bookingId) {
      skipped++;
      console.warn(`Skipping ${chatDoc.ref.path}: missing bookingId`);
      continue;
    }

    const booking = await findBooking({ db, bookingId, renterId, assetId });

    if (!booking?.startDate || !booking?.endDate) {
      skipped++;
      console.warn(`Skipping ${chatDoc.ref.path}: booking dates not found`);
      continue;
    }

    matched++;
    console.log(
      `${shouldWrite ? "Updating" : "Would update"} ${chatDoc.ref.path}: ` +
        `bookingStartDate=${booking.startDate.toDate?.() || booking.startDate}, ` +
        `bookingEndDate=${booking.endDate.toDate?.() || booking.endDate}`,
    );

    if (shouldWrite) {
      await chatDoc.ref.set(
        {
          bookingStartDate: booking.startDate,
          bookingEndDate: booking.endDate,
        },
        { merge: true },
      );
    }
  }

  console.log(
    `Chat booking date backfill complete. scanned=${scanned}, ` +
      `matched=${matched}, alreadySet=${alreadySet}, skipped=${skipped}, dryRun=${!shouldWrite}`,
  );
}

async function findBooking({ db, bookingId, renterId, assetId }) {
  const refs = [];

  if (renterId) {
    refs.push(db.doc(`users/${renterId}/bookings/${bookingId}`));
  }

  if (assetId) {
    refs.push(db.doc(`assets/${assetId}/bookings/${bookingId}`));
  }

  for (const ref of refs) {
    const snap = await ref.get();
    if (snap.exists) return snap.data();
  }

  return null;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
