const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

async function main() {
  const db = admin.firestore();
  const snapshot = await db.collectionGroup("chats").get();
  let batch = db.batch();
  let writes = 0;
  let updated = 0;

  for (const doc of snapshot.docs) {
    const ownerRoot = doc.ref.parent.parent;
    if (ownerRoot?.parent?.id !== "userChats") continue;
    const currentUid = ownerRoot.id;
    const chat = doc.data();
    const participantIds = Array.isArray(chat.participantIds)
      ? chat.participantIds.filter(Boolean)
      : Array.isArray(chat.participants)
        ? chat.participants.map((participant) => participant?.uid).filter(Boolean)
        : [];
    const otherParticipantId = participantIds.find((uid) => uid !== currentUid) || null;
    if (!otherParticipantId || (chat.otherParticipantId && chat.participantIds)) continue;

    batch.set(doc.ref, { participantIds, otherParticipantId }, { merge: true });
    writes += 1;
    updated += 1;
    if (writes === 450) {
      await batch.commit();
      batch = db.batch();
      writes = 0;
    }
  }

  if (writes > 0) await batch.commit();
  console.log(`Updated ${updated} chat mirrors.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
