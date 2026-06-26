const admin = require("firebase-admin");

const shouldWrite = process.env.RUN_BACKFILL === "true";
const supportUserId = process.env.LEND_SUPPORT_USER_ID || "lend_support";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

async function main() {
  const db = admin.firestore();
  const chatsSnap = await db.collection("chats").get();

  let chatsScanned = 0;
  let messagesScanned = 0;
  let matched = 0;
  let skipped = 0;

  for (const chatDoc of chatsSnap.docs) {
    chatsScanned++;
    const chatId = chatDoc.id;
    const chat = chatDoc.data() || {};
    const context = await buildChatVisibilityContext({ db, chatId, chat });
    const messagesSnap = await chatDoc.ref.collection("messages").where("visibleTo", "==", null).get();

    for (const messageDoc of messagesSnap.docs) {
      messagesScanned++;
      const message = messageDoc.data() || {};
      const visibleTo = resolveVisibleTo({ message, context });

      if (visibleTo.length === 0) {
        skipped++;
        console.warn(`Skipping ${messageDoc.ref.path}: unable to infer visibleTo`);
        continue;
      }

      matched++;
      console.log(`${shouldWrite ? "Updating" : "Would update"} ${messageDoc.ref.path}: visibleTo=${visibleTo.join(",")}`);

      if (shouldWrite) {
        await messageDoc.ref.set({ visibleTo }, { merge: true });
      }
    }
  }

  console.log(
    `Message visibility backfill complete. chatsScanned=${chatsScanned}, ` +
      `messagesScanned=${messagesScanned}, matched=${matched}, skipped=${skipped}, dryRun=${!shouldWrite}`,
  );
}

async function buildChatVisibilityContext({ db, chatId, chat }) {
  const mirrorSnap = await db.collectionGroup("chats").where("chatId", "==", chatId).get();
  const mirrorUserIds = [];
  let renterId = chat.renterId || null;

  for (const mirrorDoc of mirrorSnap.docs) {
    const uid = mirrorDoc.ref.parent.parent?.id;
    if (uid && !mirrorUserIds.includes(uid)) {
      mirrorUserIds.push(uid);
    }

    const mirror = mirrorDoc.data() || {};
    renterId = renterId || mirror.renterId || null;
  }

  const participantUserId = chat.participantUserId || null;
  const rootSupportUserId = chat.supportUserId || null;
  const isSupportChat = chat.chatType === "Support" || Boolean(participantUserId || rootSupportUserId);
  const participantIds = unique([
    ...mirrorUserIds,
    ...(isSupportChat ? [participantUserId, rootSupportUserId || supportUserId] : []),
  ]);

  return {
    chatId,
    isSupportChat,
    participantIds,
    renterId,
  };
}

function resolveVisibleTo({ message, context }) {
  if (message.type === "rating" || message.systemAction === "rating_request") {
    return unique([context.renterId]);
  }

  return context.participantIds;
}

function unique(values) {
  return values.filter(Boolean).filter((value, index, array) => array.indexOf(value) === index);
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
  resolveVisibleTo,
  unique,
};
