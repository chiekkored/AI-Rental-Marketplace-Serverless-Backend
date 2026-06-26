const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

const db = admin.firestore();
const shouldDeleteLegacy = process.argv.includes("--delete-legacy");
const legacyAdminTypes = ["Admin", "admin"];
const batchLimit = 400;

async function migrateAdminUsersCollection() {
  const snapshots = await Promise.all(
    legacyAdminTypes.map((type) =>
      db.collection("users").where("type", "==", type).get(),
    ),
  );
  const docs = new Map();
  snapshots.forEach((snapshot) => {
    snapshot.docs.forEach((doc) => {
      docs.set(doc.id, doc);
    });
  });

  if (docs.size === 0) {
    console.log("No legacy admin users found in users.");
    return;
  }

  let batch = db.batch();
  let batchCount = 0;
  let migratedCount = 0;

  async function commitBatchIfNeeded(force = false) {
    if (batchCount === 0 || (!force && batchCount < batchLimit)) {
      return;
    }

    await batch.commit();
    batch = db.batch();
    batchCount = 0;
  }

  for (const doc of docs.values()) {
    const data = doc.data();
    const adminUserRef = db.collection("adminUsers").doc(doc.id);
    const fallbackDisplayName = [data.firstName, data.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();
    batch.set(
      adminUserRef,
      {
        uid: data.uid ?? doc.id,
        email: data.email ?? null,
        firstName: data.firstName ?? null,
        lastName: data.lastName ?? null,
        displayName: data.displayName ?? (fallbackDisplayName || null),
        photoUrl: data.photoUrl ?? null,
        createdAt: data.createdAt ?? admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        adminType: data.adminType ?? "admin",
        status: data.status === "Deleted" ? "Deleted" : "Active",
        createdBy: data.createdBy ?? "migration",
        updatedBy: "migration",
        deletedAt: data.deletedAt ?? null,
        deletedBy: data.deletedBy ?? null,
      },
      { merge: true },
    );

    if (shouldDeleteLegacy) {
      batch.delete(doc.ref);
      batchCount += 1;
    }

    batchCount += 1;
    migratedCount += 1;
    await commitBatchIfNeeded();
  }

  await commitBatchIfNeeded(true);
  console.log(
    `Migrated ${migratedCount} admin users to adminUsers` +
      (shouldDeleteLegacy ? " and deleted legacy users docs." : "."),
  );
}

migrateAdminUsersCollection()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Failed to migrate admin users.", error);
    process.exit(1);
  });
