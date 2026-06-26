const admin = require("firebase-admin");
const functions = require("firebase-functions");
const { throwAndLogHttpsError } = require("../../utils/error.util");
const {
  OWNER_INVITES_COLLECTION,
  buildFoundingOwnerUserPayload,
  hashOwnerInviteValue,
  isOwnerInviteExpired,
  isOwnerInvitePubliclyAvailable,
  normalizeOwnerInviteCode,
  normalizeOwnerInviteSlug,
  ownerInviteClaimResult,
  publicOwnerInvitePayload,
} = require("./ownerInvite.util");

const FieldValue = admin.firestore.FieldValue;

async function resolveOwnerInvite(request) {
  try {
    const slug = normalizeOwnerInviteSlug(request.data?.slug);
    const inviteRef = admin.firestore().collection(OWNER_INVITES_COLLECTION).doc(slug);
    const inviteSnap = await inviteRef.get();

    if (!inviteSnap.exists || !isOwnerInvitePubliclyAvailable(inviteSnap.data())) {
      return { invite: null };
    }

    return { invite: publicOwnerInvitePayload(inviteSnap.id, inviteSnap.data()) };
  } catch (error) {
    rethrowExpected(error);
    console.error("Failed to resolve owner invite", error);
    throwAndLogHttpsError("internal", "Unable to load this invite.");
  }
}

async function recordOwnerInviteOpen(request) {
  try {
    const slug = normalizeOwnerInviteSlug(request.data?.slug);
    const inviteRef = admin.firestore().collection(OWNER_INVITES_COLLECTION).doc(slug);
    const inviteSnap = await inviteRef.get();

    if (!inviteSnap.exists || !isOwnerInvitePubliclyAvailable(inviteSnap.data())) {
      return { ok: false };
    }

    await inviteRef.set(
      {
        lastOpenedAt: FieldValue?.serverTimestamp() || new Date(),
        openCount: FieldValue?.increment(1) || 1,
        updatedAt: FieldValue?.serverTimestamp() || new Date(),
      },
      { merge: true },
    );

    return { ok: true };
  } catch (error) {
    rethrowExpected(error);
    console.error("Failed to record owner invite open", error);
    throwAndLogHttpsError("internal", "Unable to record this invite.");
  }
}

async function claimOwnerInvite(request) {
  try {
    const uid = request.auth?.uid;
    if (!uid) {
      throwAndLogHttpsError("permission-denied", "Sign in before claiming an invite.");
    }

    const code = normalizeOwnerInviteCode(request.data?.code);
    const codeHash = hashOwnerInviteValue(code);
    const inviteQuery = await admin
      .firestore()
      .collection(OWNER_INVITES_COLLECTION)
      .where("codeHash", "==", codeHash)
      .limit(2)
      .get();

    if (inviteQuery.empty) {
      throwAndLogHttpsError("not-found", "Invite code not found.");
    }

    if (inviteQuery.docs.length > 1) {
      throwAndLogHttpsError("failed-precondition", "Invite code is not unique.");
    }

    const inviteRef = inviteQuery.docs[0].ref;
    const userRef = admin.firestore().collection("users").doc(uid);

    const result = await admin.firestore().runTransaction(async (transaction) => {
      const [inviteSnap, userSnap] = await Promise.all([
        transaction.get(inviteRef),
        transaction.get(userRef),
      ]);

      if (!inviteSnap.exists) {
        throwAndLogHttpsError("not-found", "Invite code not found.");
      }

      const invite = inviteSnap.data();
      const user = userSnap.data() || {};
      const existingInviteId =
        user.foundingOwner?.inviteId || user.foundingOwnerInvite?.inviteId;

      if (existingInviteId && existingInviteId !== inviteSnap.id) {
        throwAndLogHttpsError("already-exists", "This account already has a founding owner invite.");
      }

      if (existingInviteId === inviteSnap.id) {
        if (user.isFoundingOwner !== true || !user.foundingOwner?.inviteId) {
          const claimedAt =
            user.foundingOwner?.claimedAt ||
            user.foundingOwnerInvite?.claimedAt ||
            FieldValue?.serverTimestamp() ||
            new Date();
          const foundingOwner = buildFoundingOwnerUserPayload(inviteSnap.id, invite, claimedAt);
          transaction.set(
            userRef,
            {
              foundingOwner,
              foundingOwnerInvite: foundingOwner,
              isFoundingOwner: true,
              updatedAt: FieldValue?.serverTimestamp() || new Date(),
            },
            { merge: true },
          );
        }
        return ownerInviteClaimResult(inviteSnap.id, invite, { alreadyClaimed: true });
      }

      if (invite.status !== "Active") {
        throwAndLogHttpsError("failed-precondition", "This invite is not active.");
      }

      if (isOwnerInviteExpired(invite)) {
        throwAndLogHttpsError("failed-precondition", "This invite has expired.");
      }

      const maxClaims = Number.isFinite(invite.maxClaims) ? invite.maxClaims : 1;
      const claimCount = Number.isFinite(invite.claimCount) ? invite.claimCount : 0;
      if (claimCount >= maxClaims) {
        throwAndLogHttpsError("already-exists", "This invite has already been claimed.");
      }

      const now = FieldValue?.serverTimestamp() || new Date();
      const foundingOwner = buildFoundingOwnerUserPayload(inviteSnap.id, invite, now);

      transaction.set(
        userRef,
        {
          foundingOwner,
          foundingOwnerInvite: foundingOwner,
          isFoundingOwner: true,
          updatedAt: now,
        },
        { merge: true },
      );

      transaction.set(
        inviteRef,
        {
          claimCount: FieldValue?.increment(1) || claimCount + 1,
          claimedAt: now,
          claimedByUid: uid,
          status: claimCount + 1 >= maxClaims ? "Claimed" : invite.status,
          updatedAt: now,
        },
        { merge: true },
      );

      return ownerInviteClaimResult(inviteSnap.id, invite, { claimed: true });
    });

    return result;
  } catch (error) {
    rethrowExpected(error);
    console.error("Failed to claim owner invite", error);
    throwAndLogHttpsError("internal", "Unable to claim this invite.");
  }
}

function rethrowExpected(error) {
  if (error instanceof functions.https.HttpsError) {
    throw error;
  }
}

module.exports = {
  claimOwnerInvite,
  recordOwnerInviteOpen,
  resolveOwnerInvite,
};
