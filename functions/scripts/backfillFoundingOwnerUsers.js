const admin = require("firebase-admin");
const {
  buildFoundingOwnerUserPayload,
} = require("../calls/owner-invites/ownerInvite.util");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

const db = admin.firestore();
const batchLimit = 400;

async function backfillFoundingOwnerUsers() {
  const snapshot = await db.collection("users").where("foundingOwnerInvite.inviteId", ">", "").get();

  if (snapshot.empty) {
    console.log("No legacy founding owner invite users found.");
    return;
  }

  let batch = db.batch();
  let batchCount = 0;
  let backfilledCount = 0;

  async function commitBatchIfNeeded(force = false) {
    if (batchCount === 0 || (!force && batchCount < batchLimit)) {
      return;
    }

    await batch.commit();
    batch = db.batch();
    batchCount = 0;
  }

  for (const userDoc of snapshot.docs) {
    const user = userDoc.data();
    const legacy = user.foundingOwnerInvite;
    if (!legacy?.inviteId || user.isFoundingOwner === true && user.foundingOwner?.inviteId) {
      continue;
    }

    const foundingOwner = buildFoundingOwnerUserPayload(
      legacy.inviteId,
      {
        code: legacy.inviteCode || legacy.code,
        displayName: legacy.displayName,
        perks: legacy.perks,
        slug: legacy.inviteSlug || legacy.slug || legacy.inviteId,
        targetCategory: legacy.targetCategory || null,
        targetLocation: legacy.targetLocation || null,
      },
      legacy.claimedAt || admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    );

    batch.set(
      userDoc.ref,
      {
        foundingOwner,
        foundingOwnerInvite: foundingOwner,
        isFoundingOwner: true,
        updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      },
      { merge: true },
    );
    batchCount += 1;
    backfilledCount += 1;
    await commitBatchIfNeeded();
  }

  await commitBatchIfNeeded(true);
  console.log(`Backfilled ${backfilledCount} founding owner users.`);
}

backfillFoundingOwnerUsers()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Failed to backfill founding owner users.", error);
    process.exit(1);
  });
