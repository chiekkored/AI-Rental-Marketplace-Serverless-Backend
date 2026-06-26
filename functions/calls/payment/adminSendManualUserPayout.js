const functions = require("firebase-functions");
const {
  PAYOUT_STATUS,
  admin,
  createWalletTransaction,
  getPayMongoWalletId,
  getPayMongoWebhookUrl,
  normalizeCurrency,
  normalizePayMongoError,
  normalizePositiveAmount,
  resolvePayoutProvider,
  roundCurrency,
  sendNotificationToUser,
  throwAndLogHttpsError,
  toPayMongoReceiver,
  userPaymentProfileRef,
} = require("./utils/paymentFlow.util");

const DESTINATION_KIND = {
  auto: "auto",
  depositReturn: "deposit_return",
  payout: "payout_destination",
};

async function adminSendManualUserPayout(request) {
  try {
    const auth = request.auth;
    const { uid, amount, currency, destinationKind, idempotencyKey, reason } = request.data || {};
    if (!auth?.token?.admin) throwAndLogHttpsError("permission-denied", "Only admins can send money to users");

    const targetUid = normalizeUid(uid);
    const normalizedAmount = normalizePositiveAmount(amount, "amount");
    const normalizedCurrency = normalizeCurrency(currency || "PHP");
    const normalizedDestinationKind = normalizeDestinationKind(destinationKind);
    const normalizedReason = normalizeReason(reason);
    const transferKey = normalizeIdempotencyKey(idempotencyKey);
    const db = admin.firestore();
    const transferRef = db.collection("adminManualWalletTransfers").doc(`${targetUid}_${transferKey}`);
    const existingSnap = await transferRef.get();

    if (existingSnap.exists) {
      return buildTransferResponse(existingSnap.data(), true);
    }

    const [targetUserSnap, paymentSnap] = await Promise.all([
      db.collection("users").doc(targetUid).get(),
      userPaymentProfileRef(targetUid).get(),
    ]);

    if (!targetUserSnap.exists) throwAndLogHttpsError("not-found", "User not found");

    const { destination, resolvedDestinationKind } = resolveManualPayoutDestination({
      destinationKind: normalizedDestinationKind,
      paymentProfile: paymentSnap.data() || {},
    });

    if (!destination) throwAndLogHttpsError("failed-precondition", "User does not have a payment destination");

    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
    const basePayload = {
      id: transferRef.id,
      targetUserId: targetUid,
      adminUserId: auth.uid,
      amount: normalizedAmount,
      currency: normalizedCurrency,
      reason: normalizedReason,
      requestedDestinationKind: normalizedDestinationKind,
      destinationKind: resolvedDestinationKind,
      destinationSummary: summarizeDestination(destination),
      status: PAYOUT_STATUS.processing,
      createdAt: now,
      updatedAt: now,
    };

    await transferRef.set(basePayload, { merge: true });

    if (process.env.FUNCTIONS_EMULATOR === "true") {
      const payload = {
        ...basePayload,
        status: PAYOUT_STATUS.succeeded,
        emulatorBypass: true,
        updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      };
      await transferRef.set(payload, { merge: true });
      await notifyManualPayoutUser({ amount: normalizedAmount, currency: normalizedCurrency, transferId: transferRef.id, uid: targetUid });
      return buildTransferResponse(payload, false);
    }

    const walletId = getPayMongoWalletId();
    if (!walletId) {
      await transferRef.set(
        {
          status: PAYOUT_STATUS.configurationRequired,
          error: "PAYMONGO_WALLET_ID is not configured",
          updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        },
        { merge: true },
      );
      throwAndLogHttpsError("failed-precondition", "Wallet payout is not configured");
    }

    try {
      const walletTransaction = await createWalletTransaction({
        walletId,
        amount: normalizedAmount,
        currency: normalizedCurrency,
        provider: resolvePayoutProvider({ destination, amount: normalizedAmount }),
        description: `Lend manual user payout ${transferRef.id}`,
        callbackUrl: getPayMongoWebhookUrl(),
        receiver: toPayMongoReceiver(destination),
      });
      const attrs = walletTransaction?.data?.attributes || {};
      const status = attrs.status || PAYOUT_STATUS.processing;
      const payload = {
        status,
        paymongoWalletTransactionId: walletTransaction?.data?.id || null,
        referenceNumber: attrs.reference_number || null,
        paymongoStatus: attrs.status || null,
        updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      };
      await transferRef.set(payload, { merge: true });
      await notifyManualPayoutUser({ amount: normalizedAmount, currency: normalizedCurrency, transferId: transferRef.id, uid: targetUid });
      return buildTransferResponse({ ...basePayload, ...payload }, false);
    } catch (error) {
      const normalized = normalizePayMongoError(error);
      await transferRef.set(
        {
          status: PAYOUT_STATUS.failed,
          error: normalized.message,
          paymongoErrors: normalized.errors,
          updatedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        },
        { merge: true },
      );
      throwAndLogHttpsError("internal", `Unable to send money: ${normalized.message}`, normalized);
    }
  } catch (error) {
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    functions.logger.error("Unhandled error in adminSendManualUserPayout", error);
    throwAndLogHttpsError("internal", "Unable to send money to user");
  }
}

function normalizeUid(value) {
  const uid = typeof value === "string" ? value.trim() : "";
  if (!uid) throwAndLogHttpsError("invalid-argument", "Missing user id");
  if (uid.includes("/")) throwAndLogHttpsError("invalid-argument", "Invalid user id");
  return uid;
}

function normalizeDestinationKind(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return Object.values(DESTINATION_KIND).includes(normalized) ? normalized : DESTINATION_KIND.auto;
}

function normalizeReason(value) {
  const reason = typeof value === "string" ? value.trim() : "";
  if (!reason) throwAndLogHttpsError("invalid-argument", "Missing reason");
  if (reason.length > 500) throwAndLogHttpsError("invalid-argument", "Reason is too long");
  return reason;
}

function normalizeIdempotencyKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(key)) {
    throwAndLogHttpsError("invalid-argument", "Invalid idempotency key");
  }
  return key;
}

function resolveManualPayoutDestination({ destinationKind, paymentProfile }) {
  const depositReturnDestination = paymentProfile?.depositReturnDestination || null;
  const payoutDestination = paymentProfile?.payoutDestination || null;

  if (destinationKind === DESTINATION_KIND.depositReturn) {
    return { destination: depositReturnDestination, resolvedDestinationKind: DESTINATION_KIND.depositReturn };
  }

  if (destinationKind === DESTINATION_KIND.payout) {
    return { destination: payoutDestination, resolvedDestinationKind: DESTINATION_KIND.payout };
  }

  if (depositReturnDestination) {
    return { destination: depositReturnDestination, resolvedDestinationKind: DESTINATION_KIND.depositReturn };
  }

  return { destination: payoutDestination, resolvedDestinationKind: DESTINATION_KIND.payout };
}

function summarizeDestination(destination) {
  const accountNumber = String(destination?.accountNumber || "");
  return {
    bankId: destination?.bankId || null,
    bankCode: destination?.bankCode || null,
    bankName: destination?.bankName || null,
    destinationType: destination?.destinationType || "bank",
    provider: destination?.provider || null,
    accountLast4: accountNumber ? accountNumber.slice(-4) : null,
  };
}

async function notifyManualPayoutUser({ amount, currency, transferId, uid }) {
  const formattedAmount = `${normalizeCurrency(currency)} ${formatExactAmount(amount)}`;
  return sendNotificationToUser({
    uid,
    title: "Money sent to you",
    body: `Lend sent you ${formattedAmount}.`,
    data: {
      type: "manual_user_payout",
      amount: roundCurrency(amount),
      currency: normalizeCurrency(currency),
      transferId,
    },
    persist: true,
    push: true,
  }).catch((error) => {
    console.warn(`[adminSendManualUserPayout] Failed to notify user: ${error.message}`);
    return null;
  });
}

function formatExactAmount(value) {
  const amount = roundCurrency(Number(value || 0));
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function buildTransferResponse(payload, idempotent) {
  return {
    success: true,
    idempotent,
    transferId: payload?.id || null,
    status: payload?.status || null,
    amount: payload?.amount || null,
    currency: payload?.currency || null,
    destinationKind: payload?.destinationKind || null,
  };
}

module.exports = {
  adminSendManualUserPayout,
  _test: {
    normalizeDestinationKind,
    normalizeIdempotencyKey,
    resolveManualPayoutDestination,
    summarizeDestination,
  },
};
