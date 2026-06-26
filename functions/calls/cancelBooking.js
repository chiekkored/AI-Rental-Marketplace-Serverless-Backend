const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  BOOKING_STATUS,
  CHAT_STATUS,
  getBookingRefs,
  getLifecycleMessageId,
  formatBookingPurpose,
  formatBookingSubject,
  parseFirestoreDate,
} = require("../utils/booking.util");
const { pendingBookingCountIncrementValue } = require("../utils/pendingBookingCount.util");
const { normalizePayMongoError, createRefund } = require("../utils/paymongo.util");
const { firstListingImageUrl, sendNotificationToUser } = require("../utils/notification.util");
const { sendBookingCancelledEmails, sendRefundEmail } = require("../utils/transactionalEmail.util");
const { getPricingPolicyConfig } = require("../utils/remoteConfig.util");
const { createOwnerCancellationPayout, PAYOUT_STATUS } = require("./payment/utils/paymentFlow.util");

const CANCELLATION_STATUS = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
};

const REFUND_STATUS = {
  notStarted: "not_started",
  processing: "processing",
  succeeded: "succeeded",
  failed: "failed",
  notRefundable: "not_refundable",
};

const CANCELLATION_ACTOR_ROLE = {
  owner: "owner",
  renter: "renter",
};

const OWNER_CANCELLATION_PENALTY_STATUS = {
  open: "open",
  partiallyApplied: "partially_applied",
  applied: "applied",
};

const OWNER_CANCELLATION_PENALTY_TYPE = "owner_cancellation";
const OWNER_CANCELLATION_PENALTY_CUTOFF_HOURS = 48;
const OWNER_CANCELLATION_LISTING_STATUS = "Under Maintenance";
const RENTER_CANCELLATION_POLICY_TYPE = "renter_cancellation";
const RENTER_SHORT_LEAD_NO_REFUND_HOURS = 24;
const PHILIPPINES_TIMEZONE_OFFSET_HOURS = 8;
const RENTER_CANCELLATION_TIER = {
  fullRefund: "full_refund",
  partialRefund: "partial_refund",
  noRefund: "no_refund",
};

exports.requestBookingCancellation = async (request) => {
  const auth = request.auth;
  const { assetId, bookingId, reason } = request.data || {};

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (!assetId || !bookingId) {
    throwAndLogHttpsError("invalid-argument", "Missing assetId or bookingId");
  }

  const cancelReason = normalizeCancelReason(reason);
  const db = admin.firestore();
  const assetBookingRef = db.collection("assets").doc(assetId).collection("bookings").doc(bookingId);
  const assetBookingSnap = await assetBookingRef.get();

  if (!assetBookingSnap.exists) {
    throwAndLogHttpsError("not-found", "Booking not found");
  }

  const booking = assetBookingSnap.data();
  const renterId = booking?.renter?.uid;
  const ownerId = booking?.asset?.owner?.uid;
  const chatId = booking?.chatId;

  if (!renterId || !ownerId) {
    throwAndLogHttpsError("failed-precondition", "Booking participants are missing");
  }

  const actorRole = resolveCancellationActorRole({ authUid: auth.uid, renterId, ownerId });
  const requestedAt = new Date();
  assertBookingCancellationRequestAllowed({ booking, actorRole, now: requestedAt });

  const { rootBookingRef, userBookingRef } = getBookingRefs({ assetId, bookingId, renterId });
  const ownerAssetMirrorRef = db.collection("users").doc(ownerId).collection("assets").doc(assetId);
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  const previousStatus = booking.status;
  const pricingPolicy = actorRole === CANCELLATION_ACTOR_ROLE.renter ? await getPricingPolicyConfig() : null;
  const penaltyPreview =
    actorRole === CANCELLATION_ACTOR_ROLE.owner ? buildOwnerCancellationPenaltyPreview({ booking, requestedAt }) : null;
  const renterPenaltyPreview =
    actorRole === CANCELLATION_ACTOR_ROLE.renter
      ? buildRenterCancellationPolicyPreview({
          booking,
          policy: pricingPolicy.renterCancellationPolicy,
          requestedAt,
        })
      : null;

  await db.runTransaction(async (tx) => {
    const latestAssetBookingSnap = await tx.get(assetBookingRef);
    if (!latestAssetBookingSnap.exists) {
      throwAndLogHttpsError("not-found", "Booking not found");
    }

    const latestBooking = latestAssetBookingSnap.data();
    assertBookingCancellationRequestAllowed({ booking: latestBooking, actorRole, now: new Date() });

    const ownerAssetMirrorSnap = await tx.get(ownerAssetMirrorRef);
    const latestPenaltyPreview =
      actorRole === CANCELLATION_ACTOR_ROLE.owner
        ? buildOwnerCancellationPenaltyPreview({ booking: latestBooking, requestedAt })
        : null;
    const latestRenterPenaltyPreview =
      actorRole === CANCELLATION_ACTOR_ROLE.renter
        ? buildRenterCancellationPolicyPreview({
            booking: latestBooking,
            policy: pricingPolicy.renterCancellationPolicy,
            requestedAt,
          })
        : null;
    const cancellationRequest = {
      status: CANCELLATION_STATUS.pending,
      requestedBy: auth.uid,
      requestedByRole: actorRole,
      requestedAt: now,
      reason: cancelReason,
      previousStatus: latestBooking.status,
      refundStatus: REFUND_STATUS.notStarted,
      requiresUrgentAdminReview:
        actorRole === CANCELLATION_ACTOR_ROLE.owner &&
        isWithinOwnerCancellationPenaltyCutoff(latestBooking, requestedAt),
      ownerPenaltyPreview: latestPenaltyPreview,
      renterPenaltyPreview: latestRenterPenaltyPreview,
    };
    const updateData = {
      status: BOOKING_STATUS.cancellationRequested,
      cancellationRequest,
      lastUpdated: now,
    };

    updateBookingMirrors(tx, { assetBookingRef, rootBookingRef, userBookingRef }, updateData);

    if (latestBooking.status === BOOKING_STATUS.pending) {
      tx.set(
        ownerAssetMirrorRef,
        {
          pendingBookingCount: pendingBookingCountIncrementValue({
            fieldValue: admin.firestore.FieldValue,
            currentValue: ownerAssetMirrorSnap.data()?.pendingBookingCount,
            delta: -1,
          }),
        },
        { merge: true },
      );
    }

    if (chatId) {
      const messageText = "A cancellation request is under review.";
      const chatUpdate = buildCancellationRequestedChatUpdate({ messageText, now });
      const messageRef = recurringCancellationMessageRef(db, {
        bookingId,
        chatId,
        eventName: "cancellation-requested",
      });

      tx.set(
        messageRef,
        buildCancellationSystemMessageData({
          messageId: messageRef.id,
          messageText,
          now,
          renterId,
          ownerId,
        }),
      );
      tx.set(db.collection("userChats").doc(renterId).collection("chats").doc(chatId), chatUpdate, { merge: true });
      tx.set(db.collection("userChats").doc(ownerId).collection("chats").doc(chatId), chatUpdate, { merge: true });
    }
  });

  await Promise.allSettled([
    sendNotificationToUser({
      uid: renterId,
      title: "Cancellation under review",
      body: buildCancellationRequestNotificationBody({
        booking,
        recipientRole: CANCELLATION_ACTOR_ROLE.renter,
        actorRole,
      }),
      imageUrl: firstListingImageUrl(booking?.asset),
      push: false,
      data: {
        type: "booking",
        chatId,
        bookingId,
        assetId,
        senderId: auth.uid,
      },
    }),
    sendNotificationToUser({
      uid: ownerId,
      title: "Cancellation in process",
      body: buildCancellationRequestNotificationBody({
        booking,
        recipientRole: CANCELLATION_ACTOR_ROLE.owner,
        actorRole,
      }),
      imageUrl: firstListingImageUrl(booking?.asset),
      push: false,
      data: {
        type: "booking",
        chatId,
        bookingId,
        assetId,
        senderId: auth.uid,
      },
    }),
  ]).then((results) => {
    results.forEach((result) => {
      if (result.status === "rejected") {
        console.warn(`[requestBookingCancellation] Failed to send notification: ${result.reason?.message}`);
      }
    });
  });

  return {
    success: true,
    previousStatus,
    requestedByRole: actorRole,
    ownerPenaltyPreview: penaltyPreview,
    renterPenaltyPreview,
  };
};

exports.reviewBookingCancellation = async (request) => {
  const auth = request.auth;
  const { assetId, bookingId, renterId, decision, notes, refundAmount, refundType } = request.data || {};

  if (!auth?.token?.admin) {
    throwAndLogHttpsError("permission-denied", "Only admins can review cancellation requests");
  }

  if (!assetId || !bookingId || !renterId) {
    throwAndLogHttpsError("invalid-argument", "Missing assetId, bookingId, or renterId");
  }

  if (decision !== "approve" && decision !== "reject") {
    throwAndLogHttpsError("invalid-argument", "Decision must be approve or reject");
  }

  if (decision === "reject") {
    return rejectBookingCancellation({ assetId, bookingId, renterId, adminId: auth.uid, notes });
  }

  return approveBookingCancellation({
    assetId,
    bookingId,
    renterId,
    adminId: auth.uid,
    notes,
    refundAmount,
    refundType,
  });
};

exports.adminUpdateBookingStatus = async (request) => {
  const auth = request.auth;
  const { assetId, bookingId, renterId, status, notes, refundAmount, refundType } = request.data || {};

  if (!auth?.token?.admin) {
    throwAndLogHttpsError("permission-denied", "Only admins can update booking statuses");
  }

  if (!assetId || !bookingId || !renterId || !status) {
    throwAndLogHttpsError("invalid-argument", "Missing assetId, bookingId, renterId, or status");
  }

  if (!Object.values(BOOKING_STATUS).includes(status)) {
    throwAndLogHttpsError("invalid-argument", "Invalid booking status");
  }

  const statusRequiresRefundReview = status === BOOKING_STATUS.cancelled || status === BOOKING_STATUS.declined;
  return updateBookingStatusAsAdmin({
    assetId,
    bookingId,
    renterId,
    adminId: auth.uid,
    status,
    notes,
    refundAmount,
    refundType,
    statusRequiresRefundReview,
  });
};

async function updateBookingStatusAsAdmin({
  assetId,
  bookingId,
  renterId,
  adminId,
  status,
  notes,
  refundAmount,
  refundType,
  statusRequiresRefundReview,
}) {
  const db = admin.firestore();
  const { assetBookingRef, rootBookingRef, userBookingRef } = getBookingRefs({ assetId, bookingId, renterId });
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  let bookingForRefund = null;
  let refundPlan = null;

  await db.runTransaction(async (tx) => {
    const bookingSnap = await tx.get(assetBookingRef);
    if (!bookingSnap.exists) {
      throwAndLogHttpsError("not-found", "Booking not found");
    }

    const booking = bookingSnap.data();
    bookingForRefund = booking;
    const ownerId = booking?.asset?.owner?.uid;
    const chatId = booking?.chatId;
    const previousStatus = booking?.status;
    const ownerAssetMirrorRef = ownerId ? db.collection("users").doc(ownerId).collection("assets").doc(assetId) : null;
    const ownerAssetMirrorSnap = ownerAssetMirrorRef ? await tx.get(ownerAssetMirrorRef) : null;
    const paidAmount = getPaidBookingAmount(booking);
    if (statusRequiresRefundReview && paidAmount > 0) {
      refundPlan = resolveCancellationRefundPlan({ booking, refundAmount, refundType });
    }

    const updateData = {
      lastUpdated: now,
      status,
    };

    if (status === BOOKING_STATUS.cancelled) {
      updateData.cancelledBy = adminId;
      updateData.cancelledAt = now;
    }

    if (refundPlan) {
      updateData.cancellationRequest = {
        ...(booking?.cancellationRequest || {}),
        status: booking?.cancellationRequest?.status || CANCELLATION_STATUS.approved,
        previousStatus: booking?.cancellationRequest?.previousStatus || previousStatus || null,
        reviewedAt: now,
        reviewedBy: adminId,
        adminNotes: normalizeOptionalText(notes),
        refundStatus: refundPlan.status,
      };
      updateData.paymentFlow = {
        ...(booking?.paymentFlow || {}),
        refundAmount: refundPlan.amount,
        refundStatus: refundPlan.status,
        refundType: refundPlan.type,
      };
      if (shouldCancelOwnerPayout({ refundPlan })) {
        updateData.payoutFlow = buildCancelledOwnerPayoutFlow(booking);
      }
    }

    setBookingMirrors(tx, { assetBookingRef, rootBookingRef, userBookingRef }, updateData);

    if (ownerId && previousStatus !== status) {
      const pendingDelta = getPendingBookingDelta(previousStatus, status);
      if (pendingDelta !== 0) {
        tx.set(
          ownerAssetMirrorRef,
          {
            pendingBookingCount: pendingBookingCountIncrementValue({
              fieldValue: admin.firestore.FieldValue,
              currentValue: ownerAssetMirrorSnap.data()?.pendingBookingCount,
              delta: pendingDelta,
            }),
          },
          { merge: true },
        );
      }
    }

    if (chatId && ownerId) {
      const chatUpdate = {
        bookingStatus: status,
        lastUpdated: now,
      };
      if (status === BOOKING_STATUS.cancelled || status === BOOKING_STATUS.declined) {
        chatUpdate.status = CHAT_STATUS.archived;
      }
      tx.set(db.collection("userChats").doc(renterId).collection("chats").doc(chatId), chatUpdate, { merge: true });
      tx.set(db.collection("userChats").doc(ownerId).collection("chats").doc(chatId), chatUpdate, { merge: true });
    }
  });

  if (refundPlan?.type === "none") {
    const refundResult = await recordNoRefundForBooking({
      assetId,
      bookingId,
      renterId,
      adminId,
      booking: bookingForRefund,
      refundPlan,
    });
    return { ...refundResult, status };
  }

  if (refundPlan) {
    const refundResult = await createRefundForBooking({
      assetId,
      bookingId,
      renterId,
      adminId,
      booking: bookingForRefund,
      amount: refundPlan.amount,
    });
    return { ...refundResult, status };
  }

  if (status === BOOKING_STATUS.cancelled || status === BOOKING_STATUS.declined) {
    await sendBookingCancelledEmails({
      booking: { ...bookingForRefund, id: bookingId },
      ownerId: bookingForRefund?.asset?.owner?.uid,
      renterId,
      status: status === BOOKING_STATUS.declined ? "declined" : "cancelled",
    });
  }

  return { success: true, status };
}

async function rejectBookingCancellation({ assetId, bookingId, renterId, adminId, notes }) {
  const db = admin.firestore();
  const { assetBookingRef, rootBookingRef, userBookingRef } = getBookingRefs({ assetId, bookingId, renterId });
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  let result = null;
  let bookingForNotification = null;
  let ownerIdForNotification = null;
  let chatIdForNotification = null;

  await db.runTransaction(async (tx) => {
    const bookingSnap = await tx.get(assetBookingRef);
    if (!bookingSnap.exists) {
      throwAndLogHttpsError("not-found", "Booking not found");
    }

    const booking = bookingSnap.data();
    assertReviewableCancellation(booking);
    bookingForNotification = booking;

    const ownerId = booking?.asset?.owner?.uid;
    const chatId = booking?.chatId;
    ownerIdForNotification = ownerId;
    chatIdForNotification = chatId;
    const previousStatus = booking?.cancellationRequest?.previousStatus || BOOKING_STATUS.confirmed;
    const updateData = {
      status: previousStatus,
      cancellationRequest: {
        status: CANCELLATION_STATUS.rejected,
        reviewedAt: now,
        reviewedBy: adminId,
        adminNotes: normalizeOptionalText(notes),
        lastUpdated: now,
      },
    };

    setBookingMirrors(tx, { assetBookingRef, rootBookingRef, userBookingRef }, updateData);

    if (chatId && ownerId) {
      const messageText = "Cancellation request rejected. Booking restored.";
      const chatUpdate = {
        bookingStatus: previousStatus,
        status: CHAT_STATUS.active,
        hasRead: false,
        lastMessage: messageText,
        lastMessageDate: now,
        lastMessageSenderId: "",
        lastUpdated: now,
      };
      const messageRef = recurringCancellationMessageRef(db, {
        bookingId,
        chatId,
        eventName: "cancellation-rejected",
      });

      tx.set(
        messageRef,
        buildCancellationSystemMessageData({
          messageId: messageRef.id,
          messageText,
          now,
          renterId,
          ownerId,
        }),
      );
      tx.set(db.collection("userChats").doc(renterId).collection("chats").doc(chatId), chatUpdate, { merge: true });
      tx.set(db.collection("userChats").doc(ownerId).collection("chats").doc(chatId), chatUpdate, { merge: true });
    }

    result = { success: true, status: previousStatus };
  });

  await Promise.allSettled([
    renterId
      ? sendNotificationToUser({
          uid: renterId,
          title: "Cancellation rejected",
          body: `${formatBookingSubject(bookingForNotification)} cancellation request was rejected. The booking is active again.`,
          imageUrl: firstListingImageUrl(bookingForNotification?.asset),
          push: false,
          data: {
            type: "booking",
            chatId: chatIdForNotification,
            bookingId,
            assetId,
            senderId: adminId,
          },
        })
      : Promise.resolve(),
    ownerIdForNotification
      ? sendNotificationToUser({
          uid: ownerIdForNotification,
          title: "Cancellation rejected",
          body: `${formatBookingSubject(bookingForNotification, "A booking")} cancellation request was rejected. The booking is active again.`,
          imageUrl: firstListingImageUrl(bookingForNotification?.asset),
          push: false,
          data: {
            type: "booking",
            chatId: chatIdForNotification,
            bookingId,
            assetId,
            senderId: adminId,
          },
        })
      : Promise.resolve(),
  ]).then((results) => {
    results.forEach((notificationResult) => {
      if (notificationResult.status === "rejected") {
        console.warn(`[rejectBookingCancellation] Failed to send notification: ${notificationResult.reason?.message}`);
      }
    });
  });

  return result;
}

async function approveBookingCancellation({ assetId, bookingId, renterId, adminId, notes, refundAmount, refundType }) {
  const db = admin.firestore();
  const { assetBookingRef, rootBookingRef, userBookingRef } = getBookingRefs({ assetId, bookingId, renterId });
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  let bookingForRefund = null;
  let refundPlan = null;
  let ownerPenalty = null;
  let renterPenalty = null;

  await db.runTransaction(async (tx) => {
    const bookingSnap = await tx.get(assetBookingRef);
    if (!bookingSnap.exists) {
      throwAndLogHttpsError("not-found", "Booking not found");
    }

    const booking = bookingSnap.data();
    assertReviewableCancellation(booking);
    bookingForRefund = booking;
    refundPlan = resolveCancellationRefundPlan({ booking, refundAmount, refundType });
    const ownerId = booking?.asset?.owner?.uid;
    const ownerRequested = booking?.cancellationRequest?.requestedByRole === CANCELLATION_ACTOR_ROLE.owner;
    const renterRequested = booking?.cancellationRequest?.requestedByRole === CANCELLATION_ACTOR_ROLE.renter;
    ownerPenalty = ownerRequested ? buildOwnerCancellationPenalty({ booking, adminId, now }) : null;
    renterPenalty = renterRequested
      ? buildApprovedRenterCancellationPenalty({ booking, refundPlan, adminId, now })
      : null;

    const updateData = {
      status: BOOKING_STATUS.cancelled,
      cancellationRequest: {
        ...(booking?.cancellationRequest || {}),
        status: CANCELLATION_STATUS.approved,
        reviewedAt: now,
        reviewedBy: adminId,
        adminNotes: normalizeOptionalText(notes),
        refundStatus: refundPlan.status,
        ownerPenalty,
        renterPenalty,
      },
      paymentFlow: {
        ...(booking?.paymentFlow || {}),
        refundAmount: refundPlan.amount,
        refundStatus: refundPlan.status,
        refundType: refundPlan.type,
        renterCancellationPolicy: renterPenalty,
      },
      cancelledBy: adminId,
      cancelledAt: now,
      lastUpdated: now,
    };
    if (shouldCancelOwnerPayout({ refundPlan, renterPenalty })) {
      updateData.payoutFlow = buildCancelledOwnerPayoutFlow(booking);
    }

    setBookingMirrors(tx, { assetBookingRef, rootBookingRef, userBookingRef }, updateData);

    if (ownerPenalty && ownerId) {
      writeOwnerCancellationPenalty(tx, { db, assetId, ownerId, bookingId, ownerPenalty });
      tx.set(db.collection("assets").doc(assetId), { status: OWNER_CANCELLATION_LISTING_STATUS }, { merge: true });
      tx.set(
        db.collection("users").doc(ownerId).collection("assets").doc(assetId),
        { status: OWNER_CANCELLATION_LISTING_STATUS },
        { merge: true },
      );
    }

    const chatId = booking?.chatId;
    if (chatId && ownerId) {
      const renterMessageText = buildCancellationApprovalRenterChatText({ refundPlan });
      const ownerMessageText = buildCancellationApprovalOwnerChatText({ ownerPenalty, refundPlan, renterPenalty });
      const renterMessageRef = recurringCancellationMessageRef(db, {
        bookingId,
        chatId,
        eventName: "cancellation-approved-renter",
      });
      const ownerMessageRef = recurringCancellationMessageRef(db, {
        bookingId,
        chatId,
        eventName: "cancellation-approved-owner",
      });
      const baseChatUpdate = {
        bookingStatus: BOOKING_STATUS.cancelled,
        status: CHAT_STATUS.archived,
        hasRead: false,
        lastMessageDate: now,
        lastMessageSenderId: "",
        lastUpdated: now,
      };

      tx.set(
        renterMessageRef,
        buildCancellationSystemMessageData({
          messageId: renterMessageRef.id,
          messageText: renterMessageText,
          now,
          renterId,
          ownerId,
          visibleTo: [renterId],
        }),
      );
      tx.set(
        ownerMessageRef,
        buildCancellationSystemMessageData({
          messageId: ownerMessageRef.id,
          messageText: ownerMessageText,
          now,
          renterId,
          ownerId,
          visibleTo: [ownerId],
        }),
      );
      tx.set(
        db.collection("userChats").doc(renterId).collection("chats").doc(chatId),
        { ...baseChatUpdate, lastMessage: renterMessageText },
        { merge: true },
      );
      tx.set(
        db.collection("userChats").doc(ownerId).collection("chats").doc(chatId),
        { ...baseChatUpdate, lastMessage: ownerMessageText },
        { merge: true },
      );
    }
  });

  const ownerId = bookingForRefund?.asset?.owner?.uid;
  const chatId = bookingForRefund?.chatId;
  if (ownerId) {
    await sendNotificationToUser(
      buildCancellationApprovalOwnerNotification({
        booking: bookingForRefund,
        ownerPenalty,
        ownerId,
        chatId,
        bookingId,
        assetId,
        senderId: adminId,
      }),
    ).catch((error) => {
      console.warn(`[approveBookingCancellation] Failed to send owner notification: ${error.message}`);
    });
  }

  if (renterId && refundPlan) {
    await sendNotificationToUser(
      buildCancellationApprovalRenterNotification({
        booking: bookingForRefund,
        refundPlan,
        renterId,
        chatId,
        bookingId,
        assetId,
        senderId: adminId,
      }),
    ).catch((error) => {
      console.warn(`[approveBookingCancellation] Failed to send renter notification: ${error.message}`);
    });
  }

  if (refundPlan?.type === "none") {
    const result = await recordNoRefundForBooking({
      assetId,
      bookingId,
      renterId,
      adminId,
      booking: bookingForRefund,
      refundPlan,
    });
    const ownerPayout = await releaseRenterCancellationOwnerAmount({
      booking: bookingForRefund,
      renterPenalty,
      allowEmulatorBypass: true,
    });
    return { ...result, ownerPenalty, renterPenalty, ownerPayout };
  }

  const result = await createRefundForBooking({
    assetId,
    bookingId,
    renterId,
    adminId,
    booking: bookingForRefund,
    amount: refundPlan?.amount,
  });
  const ownerPayout = await releaseRenterCancellationOwnerAmount({
    booking: bookingForRefund,
    renterPenalty,
    allowEmulatorBypass: true,
  });
  return { ...result, ownerPenalty, renterPenalty, ownerPayout };
}

function buildCancellationApprovalRenterNotification({
  booking,
  refundPlan,
  renterId,
  chatId,
  bookingId,
  assetId,
  senderId,
}) {
  const hasRefund = refundPlan?.type === "full" || refundPlan?.type === "partial";
  const refundLabel = refundPlan?.type === "partial" ? "Partial" : "Full";
  const formattedAmount = formatCurrencyAmount(bookingCurrency(booking), refundPlan?.amount);
  const retainedOwnerAmount = Number(refundPlan?.retainedOwnerAmount || 0);

  return {
    uid: renterId,
    title: hasRefund ? "Cancellation and Refund approved" : "Cancellation approved",
    body: hasRefund
      ? `${formatBookingSubject(booking)} cancellation was approved. ${refundLabel} refund approved: ${formattedAmount}.`
      : retainedOwnerAmount > 0
        ? `${formatBookingSubject(booking)} cancellation was approved. No refund applies under the cancellation policy.`
        : `${formatBookingSubject(booking)} cancellation was approved, but this payment method is not refundable.`,
    imageUrl: firstListingImageUrl(booking?.asset),
    push: false,
    data: {
      type: "booking",
      chatId,
      bookingId,
      assetId,
      senderId,
    },
  };
}

function buildCancellationApprovalOwnerNotification({
  booking,
  ownerPenalty,
  ownerId,
  chatId,
  bookingId,
  assetId,
  senderId,
}) {
  const body = ownerPenalty
    ? `${formatBookingPurpose(booking, "cancellation was approved.", "A booking")} ${formatCurrencyAmount(
        ownerPenalty.currency,
        ownerPenalty.penaltyAmount,
      )} will be deducted from future payouts for this listing.`
    : formatBookingPurpose(booking, "cancellation was approved.", "A booking");

  return {
    uid: ownerId,
    title: "Cancellation approved",
    body,
    imageUrl: firstListingImageUrl(booking?.asset),
    push: false,
    data: {
      type: "booking",
      chatId,
      bookingId,
      assetId,
      senderId,
    },
  };
}

function buildCancellationRequestNotificationBody({ booking, recipientRole, actorRole }) {
  const subject = formatBookingSubject(
    booking,
    recipientRole === CANCELLATION_ACTOR_ROLE.owner ? "A booking" : "Your booking",
  );
  if (recipientRole === actorRole) {
    return `${subject} cancellation request is under admin review.`;
  }
  return `${subject} has a cancellation request under admin review.`;
}

function bookingCurrency(booking) {
  return booking?.paymentFlow?.currency || booking?.asset?.rates?.currency || "PHP";
}

function formatCurrencyAmount(currency, amount) {
  return `${currency || "PHP"} ${formatExactNumber(amount)}`;
}

async function createRefundForBooking({ assetId, bookingId, renterId, adminId, booking, amount: requestedAmount }) {
  const db = admin.firestore();
  const refundRef = db.collection("bookingRefunds").doc(bookingId);
  const paymentId = booking?.paymentFlow?.paymongoPaymentId || booking?.paymentFlow?.transactionId || null;
  const amount = Number(requestedAmount || booking?.paymentFlow?.amount || booking?.totalPrice || 0);
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  const { assetBookingRef, rootBookingRef, userBookingRef } = getBookingRefs({ assetId, bookingId, renterId });
  const baseRefund = {
    id: bookingId,
    assetId,
    bookingId,
    renterId,
    ownerId: booking?.asset?.owner?.uid || null,
    amount,
    currency: booking?.paymentFlow?.currency || "PHP",
    provider: "paymongo",
    refundType: amount === Number(booking?.paymentFlow?.amount || booking?.totalPrice || 0) ? "full" : "partial",
    paymongoPaymentId: paymentId,
    requestedAt: booking?.cancellationRequest?.requestedAt || null,
    approvedAt: now,
    approvedBy: adminId,
    updatedAt: now,
  };

  if (!paymentId || !amount) {
    const message = "Booking is missing PayMongo payment details for refund.";
    await writeRefundFailure({ refundRef, assetBookingRef, rootBookingRef, userBookingRef, baseRefund, message });
    await sendRefundEmail({
      booking: { ...booking, id: bookingId },
      renterId,
      refundStatus: REFUND_STATUS.failed,
    });
    return { success: true, refundStatus: REFUND_STATUS.failed, refundError: message };
  }

  try {
    const refund = await createRefund({
      amount,
      paymentId,
      reason: "requested_by_customer",
      notes: `Booking ${bookingId} cancellation approved`,
      metadata: {
        asset_id: assetId,
        booking_id: bookingId,
        refund_type: baseRefund.refundType,
        renter_id: renterId,
      },
    });
    const attrs = refund?.data?.attributes || {};
    const refundId = refund?.data?.id || null;
    const refundStatus = attrs.status || REFUND_STATUS.succeeded;
    const updateData = {
      ...baseRefund,
      status: refundStatus,
      paymongoRefundId: refundId,
      paymongoResponse: refund,
    };

    await refundRef.set(updateData, { merge: true });
    const updateObj = {
      cancellationRequest: {
        refundStatus,
      },
      paymentFlow: {
        refundStatus,
        paymongoRefundId: refundId,
        refundAmount: amount,
        refundedAt: now,
      },
      lastUpdated: now,
    };
    await setBookingMirrorsAsync({ assetBookingRef, rootBookingRef, userBookingRef }, updateObj);
    await sendRefundEmail({
      booking: { ...booking, id: bookingId },
      renterId,
      refundStatus,
    });

    return { success: true, refundStatus, refundId };
  } catch (error) {
    const normalized = normalizePayMongoError(error);
    await writeRefundFailure({
      refundRef,
      assetBookingRef,
      rootBookingRef,
      userBookingRef,
      baseRefund: {
        ...baseRefund,
        paymongoErrors: normalized.errors,
      },
      message: normalized.message,
    });
    await sendRefundEmail({
      booking: { ...booking, id: bookingId },
      renterId,
      refundStatus: REFUND_STATUS.failed,
    });
    return { success: true, refundStatus: REFUND_STATUS.failed, refundError: normalized.message };
  }
}

async function recordNoRefundForBooking({ assetId, bookingId, renterId, adminId, booking, refundPlan }) {
  const db = admin.firestore();
  const refundRef = db.collection("bookingRefunds").doc(bookingId);
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  const { assetBookingRef, rootBookingRef, userBookingRef } = getBookingRefs({ assetId, bookingId, renterId });
  const message = refundPlan?.reason || "This payment method cannot be refunded.";
  const manualSecurityDepositRefundAmount = Number(refundPlan?.manualSecurityDepositRefundAmount || 0);
  const updateData = {
    id: bookingId,
    assetId,
    bookingId,
    renterId,
    ownerId: booking?.asset?.owner?.uid || null,
    amount: 0,
    manualSecurityDepositRefundAmount,
    currency: booking?.paymentFlow?.currency || "PHP",
    provider: "paymongo",
    paymongoPaymentId: booking?.paymentFlow?.paymongoPaymentId || booking?.paymentFlow?.transactionId || null,
    requestedAt: booking?.cancellationRequest?.requestedAt || null,
    approvedAt: now,
    approvedBy: adminId,
    status: REFUND_STATUS.notRefundable,
    reason: message,
    manualRefundRequired: manualSecurityDepositRefundAmount > 0,
    updatedAt: now,
  };
  const bookingUpdate = {
    cancellationRequest: {
      refundStatus: REFUND_STATUS.notRefundable,
      refundError: null,
    },
    paymentFlow: {
      refundAmount: 0,
      refundStatus: REFUND_STATUS.notRefundable,
      refundType: "none",
      refundError: null,
      manualSecurityDepositRefundAmount,
      manualRefundRequired: manualSecurityDepositRefundAmount > 0,
    },
    lastUpdated: now,
  };

  await refundRef.set(updateData, { merge: true });
  await setBookingMirrorsAsync({ assetBookingRef, rootBookingRef, userBookingRef }, bookingUpdate);
  await sendRefundEmail({
    booking: { ...booking, id: bookingId },
    renterId,
    refundStatus: REFUND_STATUS.notRefundable,
  });

  return { success: true, refundStatus: REFUND_STATUS.notRefundable };
}

async function writeRefundFailure({ refundRef, assetBookingRef, rootBookingRef, userBookingRef, baseRefund, message }) {
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  const updateData = {
    ...baseRefund,
    status: REFUND_STATUS.failed,
    error: message,
    updatedAt: now,
  };
  const bookingUpdate = {
    cancellationRequest: {
      refundStatus: REFUND_STATUS.failed,
      refundError: message,
    },
    paymentFlow: {
      refundStatus: REFUND_STATUS.failed,
      refundError: message,
    },
    lastUpdated: now,
  };

  await refundRef.set(updateData, { merge: true });
  await setBookingMirrorsAsync({ assetBookingRef, rootBookingRef, userBookingRef }, bookingUpdate);
}

function updateBookingMirrors(tx, refs, updateData) {
  tx.update(refs.rootBookingRef, updateData);
  tx.update(refs.assetBookingRef, updateData);
  tx.update(refs.userBookingRef, updateData);
}

function setBookingMirrors(tx, refs, updateData) {
  tx.set(refs.rootBookingRef, updateData, { merge: true });
  tx.set(refs.assetBookingRef, updateData, { merge: true });
  tx.set(refs.userBookingRef, updateData, { merge: true });
}

async function setBookingMirrorsAsync(refs, updateData) {
  await Promise.all([
    refs.rootBookingRef.set(updateData, { merge: true }),
    refs.assetBookingRef.set(updateData, { merge: true }),
    refs.userBookingRef.set(updateData, { merge: true }),
  ]);
}

function buildCancellationRequestedChatUpdate({ messageText, now }) {
  return {
    bookingStatus: BOOKING_STATUS.cancellationRequested,
    status: CHAT_STATUS.active,
    hasRead: false,
    lastMessage: messageText,
    lastMessageDate: now,
    lastMessageSenderId: "",
    lastUpdated: now,
  };
}

function recurringCancellationMessageRef(db, { bookingId, chatId, eventName }) {
  const messageId = buildRecurringCancellationMessageId({
    bookingId,
    eventName,
    uniqueId: db.collection("chats").doc(chatId).collection("messages").doc().id,
  });
  return db.collection("chats").doc(chatId).collection("messages").doc(messageId);
}

function buildRecurringCancellationMessageId({ bookingId, eventName, uniqueId }) {
  if (!uniqueId) {
    throwAndLogHttpsError("invalid-argument", "Missing cancellation message id");
  }
  return `${getLifecycleMessageId(eventName, bookingId)}-${uniqueId}`;
}

function buildCancellationSystemMessageData({ messageId, messageText, now, renterId, ownerId, visibleTo }) {
  return {
    id: messageId,
    text: messageText,
    senderId: "",
    createdAt: now,
    type: "system",
    visibleTo: visibleTo ?? [renterId, ownerId],
  };
}

function buildCancellationApprovalRenterChatText({ refundPlan }) {
  if (refundPlan?.type === "none") {
    return "Cancellation approved. No refund will be made.";
  }
  return "Cancellation approved. Refund handling has started.";
}

function buildCancellationApprovalOwnerChatText({ ownerPenalty, refundPlan, renterPenalty }) {
  if (ownerPenalty) {
    return `Cancellation approved. Refund handling has started and ${formatCurrencyAmount(
      ownerPenalty.currency,
      ownerPenalty.penaltyAmount,
    )} will be deducted from future payouts for this listing.`;
  }

  if (renterPenalty?.retainedOwnerAmount > 0) {
    const refundAmount = Number(renterPenalty.refundAmount || 0);
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      return "Cancellation approved. Refund handling has started. The retained cancellation balance will be released to the owner.";
    }

    return `Cancellation approved. Refund handling has started and ${formatCurrencyAmount(
      renterPenalty.currency,
      refundAmount,
    )} will be refunded to the renter. The retained cancellation balance will be released to the owner.`;
  }

  if (refundPlan?.type === "none") {
    return "Cancellation approved. No refund will be made.";
  }

  return "Cancellation approved. The booking has been cancelled.";
}

function resolveCancellationRefundPlan({ booking, refundAmount, refundType }) {
  const renterRequested = booking?.cancellationRequest?.requestedByRole === CANCELLATION_ACTOR_ROLE.renter;
  const renterPenaltyPreview = booking?.cancellationRequest?.renterPenaltyPreview || null;
  if (isNonRefundablePaymentMethod(booking)) {
    const retainedOwnerAmount = renterRequested ? getRenterCancellationRentalBase(booking) : 0;
    const manualSecurityDepositRefundAmount = renterRequested ? getRenterCancellationSecurityDepositAmount(booking) : 0;
    return {
      amount: 0,
      reason: "QR PH and UBP Online Banking cannot be refunded.",
      status: REFUND_STATUS.notRefundable,
      type: "none",
      retainedOwnerAmount,
      manualSecurityDepositRefundAmount,
      securityDepositRefundAmount: manualSecurityDepositRefundAmount,
    };
  }

  const paidAmount = renterRequested
    ? getRenterCancellationTotalRefundableAmount(booking)
    : Number(booking?.paymentFlow?.amount || booking?.totalPrice || 0);
  if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
    throwAndLogHttpsError("failed-precondition", "Booking is missing a refundable paid amount");
  }

  const normalizedType = refundType === "partial" ? "partial" : refundType === "none" ? "none" : "full";
  if (normalizedType === "none") {
    const refundableSecurityDepositAmount = Number(
      renterPenaltyPreview?.securityDepositRefundAmount ?? getRenterCancellationSecurityDepositAmount(booking),
    );
    if (renterRequested && refundableSecurityDepositAmount > 0) {
      throwAndLogHttpsError(
        "invalid-argument",
        "No-refund approval is not allowed while the security deposit is refundable",
      );
    }
    const policyAllowsNoRefund =
      renterRequested &&
      (renterPenaltyPreview?.tier === RENTER_CANCELLATION_TIER.noRefund ||
        Number(renterPenaltyPreview?.refundAmount || 0) <= 0);
    if (!policyAllowsNoRefund) {
      throwAndLogHttpsError(
        "invalid-argument",
        "No-refund approval is only allowed for non-refundable payment methods or renter no-refund cancellation windows",
      );
    }
    return {
      amount: 0,
      reason: "Cancellation policy does not allow a refund in this window.",
      status: REFUND_STATUS.notStarted,
      type: "none",
      retainedOwnerAmount: getRenterCancellationRentalBase(booking),
      securityDepositRefundAmount: 0,
    };
  }

  if (normalizedType === "partial") {
    const amount = Number(refundAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throwAndLogHttpsError("invalid-argument", "Partial refund amount is required");
    }
    if (amount > paidAmount) {
      throwAndLogHttpsError("invalid-argument", "Partial refund amount cannot exceed the paid amount");
    }
    return {
      amount,
      status: REFUND_STATUS.processing,
      type: "partial",
      ...buildRenterRefundPlanAmounts({ booking, refundAmount: amount, renterRequested }),
    };
  }

  return {
    amount: paidAmount,
    status: REFUND_STATUS.processing,
    type: "full",
    retainedOwnerAmount: 0,
    ...(renterRequested ? buildRenterRefundPlanAmounts({ booking, refundAmount: paidAmount, renterRequested }) : {}),
  };
}

// RENTER CANCELLATION POLICY: this is the canonical calculation used by backend review,
// admin refund suggestions, and mobile payment-page cancellation visibility.
function buildRenterCancellationPolicyPreview({ booking, policy, requestedAt }) {
  const createdAt = parseFirestoreDate(booking?.createdAt);
  const startDate = parseFirestoreDate(booking?.startDate);
  if (!createdAt || !startDate || !(createdAt < startDate)) {
    throwAndLogHttpsError("failed-precondition", "Booking is missing valid cancellation policy dates");
  }
  const policyStartDate = bookingPolicyStartBoundary(startDate);

  const refundBaseAmount = getRenterCancellationRentalBase(booking);
  if (!Number.isFinite(refundBaseAmount) || refundBaseAmount <= 0) {
    throwAndLogHttpsError("failed-precondition", "Booking is missing a refundable rental amount");
  }
  const securityDepositRefundAmount = getRenterCancellationSecurityDepositAmount(booking);

  const leadTimeMs = Math.max(policyStartDate.getTime() - createdAt.getTime(), 0);
  const shortLeadNoRefund = leadTimeMs < RENTER_SHORT_LEAD_NO_REFUND_HOURS * 60 * 60 * 1000;
  const fullRefundWindowMs = resolvePolicyWindowMs(policy.fullRefundWindow, leadTimeMs);
  const noRefundWindowMs = shortLeadNoRefund ? leadTimeMs : resolvePolicyWindowMs(policy.noRefundWindow, leadTimeMs);
  const fullRefundUntil = new Date(createdAt.getTime() + fullRefundWindowMs);
  const noRefundStartsAt = new Date(policyStartDate.getTime() - noRefundWindowMs);
  const requestedTime = requestedAt.getTime();

  let tier = RENTER_CANCELLATION_TIER.partialRefund;
  let retentionRule = policy.middleRetention;
  if (shortLeadNoRefund || requestedTime >= noRefundStartsAt.getTime()) {
    tier = RENTER_CANCELLATION_TIER.noRefund;
    retentionRule = policy.noRefundRetention;
  } else if (requestedTime <= fullRefundUntil.getTime()) {
    tier = RENTER_CANCELLATION_TIER.fullRefund;
    retentionRule = { type: "percentage", rateBps: 0, fixedAmount: 0 };
  }

  const retainedOwnerAmount = calculateRetentionAmount(refundBaseAmount, retentionRule);
  const rentalRefundAmount = roundCurrency(Math.max(refundBaseAmount - retainedOwnerAmount, 0));
  const refundAmount = roundCurrency(rentalRefundAmount + securityDepositRefundAmount);
  const totalRefundableAmount = roundCurrency(refundBaseAmount + securityDepositRefundAmount);

  return {
    type: RENTER_CANCELLATION_POLICY_TYPE,
    tier,
    status: "preview",
    refundBaseAmount,
    rentalRefundAmount,
    securityDepositRefundAmount,
    totalRefundableAmount,
    refundAmount,
    retainedOwnerAmount,
    shortLeadNoRefund,
    suggestedRefundType: refundAmount <= 0 ? "none" : refundAmount >= totalRefundableAmount ? "full" : "partial",
    currency: bookingCurrency(booking),
    fullRefundWindowHours: hoursFromMs(fullRefundWindowMs),
    noRefundWindowHours: hoursFromMs(noRefundWindowMs),
    fullRefundWindowLabel: formatCancellationWindowLabel(fullRefundWindowMs),
    noRefundWindowLabel: formatCancellationWindowLabel(noRefundWindowMs),
    fullRefundUntil,
    noRefundStartsAt,
    requestedAt,
    retentionRule,
  };
}

function bookingPolicyStartBoundary(startDate) {
  return new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()) -
      PHILIPPINES_TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000,
  );
}

function buildApprovedRenterCancellationPenalty({ booking, refundPlan, adminId, now }) {
  const preview = booking?.cancellationRequest?.renterPenaltyPreview;
  if (!preview) return null;
  const refundBaseAmount = Number(preview.refundBaseAmount || getRenterCancellationRentalBase(booking));
  const securityDepositRefundAmount = Number(
    preview.securityDepositRefundAmount ?? getRenterCancellationSecurityDepositAmount(booking),
  );
  const refundAmount = roundCurrency(Number(refundPlan?.amount || 0));
  const rentalRefundAmount = roundCurrency(
    Math.min(Math.max(refundAmount - securityDepositRefundAmount, 0), refundBaseAmount),
  );
  const retainedOwnerAmount = roundCurrency(Math.max(refundBaseAmount - rentalRefundAmount, 0));
  return {
    ...preview,
    status: "approved",
    rentalRefundAmount,
    securityDepositRefundAmount,
    totalRefundableAmount: roundCurrency(refundBaseAmount + securityDepositRefundAmount),
    refundAmount,
    retainedOwnerAmount,
    manualSecurityDepositRefundAmount: Number(refundPlan?.manualSecurityDepositRefundAmount || 0),
    approvedBy: adminId,
    approvedAt: now,
    updatedAt: now,
  };
}

function getRenterCancellationRentalBase(booking) {
  const rentalSubtotal = Number(booking?.priceBreakdown?.rentalSubtotal || booking?.totalPrice || 0);
  return roundCurrency(Math.max(rentalSubtotal, 0));
}

function getRenterCancellationSecurityDepositAmount(booking) {
  const securityDepositAmount =
    booking?.securityDeposit?.enabled || booking?.depositFlow?.required
      ? Number(
          booking?.depositFlow?.amount ||
            booking?.securityDeposit?.amount ||
            booking?.priceBreakdown?.securityDepositAmount ||
            0,
        )
      : 0;
  return roundCurrency(Math.max(securityDepositAmount, 0));
}

function getRenterCancellationTotalRefundableAmount(booking) {
  return roundCurrency(getRenterCancellationRentalBase(booking) + getRenterCancellationSecurityDepositAmount(booking));
}

function buildRenterRefundPlanAmounts({ booking, refundAmount, renterRequested }) {
  if (!renterRequested) return {};
  const rentalBaseAmount = getRenterCancellationRentalBase(booking);
  const securityDepositRefundAmount = getRenterCancellationSecurityDepositAmount(booking);
  const rentalRefundAmount = roundCurrency(
    Math.min(Math.max(Number(refundAmount || 0) - securityDepositRefundAmount, 0), rentalBaseAmount),
  );
  return {
    rentalRefundAmount,
    securityDepositRefundAmount,
    retainedOwnerAmount: roundCurrency(Math.max(rentalBaseAmount - rentalRefundAmount, 0)),
  };
}

function resolvePolicyWindowMs(window, leadTimeMs) {
  const rateWindowMs = leadTimeMs * (Number(window?.leadTimeRateBps || 0) / 10000);
  const maxWindowMs = Number(window?.maxHours || 0) * 60 * 60 * 1000;
  return Math.max(Math.min(rateWindowMs, maxWindowMs), 0);
}

function calculateRetentionAmount(baseAmount, rule) {
  if (rule?.type === "fixed") {
    return roundCurrency(Math.min(Number(rule.fixedAmount || 0), baseAmount));
  }
  return roundCurrency(Math.min(baseAmount * (Number(rule?.rateBps || 0) / 10000), baseAmount));
}

function formatCancellationWindowLabel(milliseconds) {
  const hours = milliseconds / (60 * 60 * 1000);
  if (hours < 24) {
    const roundedHours = Math.max(Math.round(hours), 1);
    return `${roundedHours} ${roundedHours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.max(Math.round(hours / 24), 1);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function hoursFromMs(milliseconds) {
  return Math.round((milliseconds / (60 * 60 * 1000)) * 100) / 100;
}

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

async function releaseRenterCancellationOwnerAmount({ booking, renterPenalty, allowEmulatorBypass }) {
  const amount = Number(renterPenalty?.retainedOwnerAmount || 0);
  if (!renterPenalty || !Number.isFinite(amount) || amount <= 0) {
    return { skipped: true, reason: "zero_retained_amount" };
  }

  return createOwnerCancellationPayout({
    booking: {
      ...booking,
      paymentFlow: {
        ...(booking.paymentFlow || {}),
        renterCancellationPolicy: renterPenalty,
      },
    },
    amount,
    allowEmulatorBypass,
  });
}

function shouldCancelOwnerPayout({ refundPlan, renterPenalty }) {
  const retainedOwnerAmount = Number(renterPenalty?.retainedOwnerAmount ?? refundPlan?.retainedOwnerAmount ?? 0);
  return refundPlan?.type === "full" && (!Number.isFinite(retainedOwnerAmount) || retainedOwnerAmount <= 0);
}

function buildCancelledOwnerPayoutFlow(booking) {
  return {
    ...(booking?.payoutFlow || {}),
    ownerPayoutStatus: PAYOUT_STATUS.cancelled,
    ownerPayoutAmount: 0,
  };
}

function getPaidBookingAmount(booking) {
  const paidAmount = Number(booking?.paymentFlow?.amount || booking?.totalPrice || 0);
  return Number.isFinite(paidAmount) && paidAmount > 0 ? paidAmount : 0;
}

function getPendingBookingDelta(currentStatus, nextStatus) {
  if (currentStatus === BOOKING_STATUS.pending && nextStatus !== BOOKING_STATUS.pending) {
    return -1;
  }

  if (currentStatus !== BOOKING_STATUS.pending && nextStatus === BOOKING_STATUS.pending) {
    return 1;
  }

  return 0;
}

function isNonRefundablePaymentMethod(booking) {
  const method = booking?.paymentFlow?.method;
  const bankCode = booking?.paymentFlow?.methodDetails?.bank_code;
  return method === "qrph" || (method === "dob" && bankCode === "ubp");
}

function resolveCancellationActorRole({ authUid, renterId, ownerId }) {
  if (authUid === renterId) return CANCELLATION_ACTOR_ROLE.renter;
  if (authUid === ownerId) return CANCELLATION_ACTOR_ROLE.owner;
  throwAndLogHttpsError("permission-denied", "Only booking participants can request cancellation");
}

function assertBookingCancellationRequestAllowed({ booking, actorRole, now }) {
  if (actorRole === CANCELLATION_ACTOR_ROLE.renter) {
    assertRenterCancellationRequestAllowed(booking, now);
    return;
  }

  if (actorRole === CANCELLATION_ACTOR_ROLE.owner) {
    assertOwnerCancellationRequestAllowed(booking);
    return;
  }

  throwAndLogHttpsError("permission-denied", "Only booking participants can request cancellation");
}

function assertNoPendingCancellationRequest(booking) {
  if (booking?.cancellationRequest?.status === CANCELLATION_STATUS.pending) {
    throwAndLogHttpsError("already-exists", "Cancellation request is already under review");
  }
}

function assertRenterCancellationRequestAllowed(booking, now) {
  assertNoPendingCancellationRequest(booking);
  const allowedStatuses = [BOOKING_STATUS.pending, BOOKING_STATUS.confirmed];
  if (!allowedStatuses.includes(booking?.status)) {
    throwAndLogHttpsError("failed-precondition", "Booking is not eligible for cancellation request");
  }

  const startDate = parseFirestoreDate(booking?.startDate);
  if (!startDate || !(now < startDate)) {
    throwAndLogHttpsError("failed-precondition", "Booking dates are already active");
  }
}

function assertOwnerCancellationRequestAllowed(booking) {
  assertNoPendingCancellationRequest(booking);
  if (booking?.status !== BOOKING_STATUS.confirmed) {
    throwAndLogHttpsError("failed-precondition", "Owner can only request cancellation for confirmed bookings");
  }
}

function isWithinOwnerCancellationPenaltyCutoff(booking, now) {
  const startDate = parseFirestoreDate(booking?.startDate);
  if (!startDate) return false;
  const hoursUntilStart = (startDate.getTime() - now.getTime()) / (60 * 60 * 1000);
  return hoursUntilStart <= OWNER_CANCELLATION_PENALTY_CUTOFF_HOURS;
}

function buildOwnerCancellationPenaltyPreview({ booking, requestedAt }) {
  const penaltyRate = isWithinOwnerCancellationPenaltyCutoff(booking, requestedAt) ? 1 : 0.5;
  const penaltyBaseAmount = Number(booking?.priceBreakdown?.ownerPayoutAmount || booking?.totalPrice || 0);
  const penaltyAmount = penaltyBaseAmount * penaltyRate;
  return {
    type: OWNER_CANCELLATION_PENALTY_TYPE,
    status: OWNER_CANCELLATION_PENALTY_STATUS.open,
    penaltyRate,
    penaltyBaseAmount,
    penaltyAmount,
    remainingAmount: penaltyAmount,
    currency: bookingCurrency(booking),
    cutoffHours: OWNER_CANCELLATION_PENALTY_CUTOFF_HOURS,
    listingStatusAfterApproval: OWNER_CANCELLATION_LISTING_STATUS,
  };
}

function buildOwnerCancellationPenalty({ booking, adminId, now }) {
  const preview =
    booking?.cancellationRequest?.ownerPenaltyPreview ||
    buildOwnerCancellationPenaltyPreview({
      booking,
      requestedAt: parseFirestoreDate(booking?.cancellationRequest?.requestedAt) || new Date(),
    });
  return {
    ...preview,
    id: booking.id,
    bookingId: booking.id,
    sourceBookingId: booking.id,
    assetId: booking.asset?.id || null,
    ownerId: booking.asset?.owner?.uid || null,
    renterId: booking.renter?.uid || null,
    approvedBy: adminId,
    approvedAt: now,
    updatedAt: now,
  };
}

function writeOwnerCancellationPenalty(tx, { db, assetId, ownerId, bookingId, ownerPenalty }) {
  const penaltyPayload = {
    ...ownerPenalty,
    status:
      Number(ownerPenalty.remainingAmount || 0) > 0
        ? OWNER_CANCELLATION_PENALTY_STATUS.open
        : OWNER_CANCELLATION_PENALTY_STATUS.applied,
  };
  tx.set(db.collection("assets").doc(assetId).collection("ownerPenaltyLedger").doc(bookingId), penaltyPayload, {
    merge: true,
  });
  tx.set(db.collection("users").doc(ownerId).collection("ownerPenaltyLedger").doc(bookingId), penaltyPayload, {
    merge: true,
  });
}

function formatExactNumber(value) {
  const numberValue = Number(value || 0);
  if (!Number.isFinite(numberValue)) return "0";
  return String(numberValue);
}

function assertReviewableCancellation(booking) {
  if (booking?.status !== BOOKING_STATUS.cancellationRequested) {
    throwAndLogHttpsError("failed-precondition", "Booking does not have a pending cancellation request");
  }

  if (booking?.cancellationRequest?.status !== CANCELLATION_STATUS.pending) {
    throwAndLogHttpsError("failed-precondition", "Cancellation request is not pending");
  }
}

function normalizeCancelReason(reason) {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throwAndLogHttpsError("invalid-argument", "Missing cancellation reason");
  }

  const trimmed = reason.trim();
  if (trimmed.length > 120) {
    throwAndLogHttpsError("invalid-argument", "Cancellation reason is too long");
  }

  return trimmed;
}

function normalizeOptionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null;
}

exports.cancelBooking = exports.requestBookingCancellation;
exports._adminCancelBookingWithFullRefund = async ({
  assetId,
  bookingId,
  renterId,
  adminId,
  notes,
}) =>
  updateBookingStatusAsAdmin({
    assetId,
    bookingId,
    renterId,
    adminId,
    notes,
    refundAmount: null,
    refundType: "full",
    status: BOOKING_STATUS.cancelled,
    statusRequiresRefundReview: true,
  });

exports._adminDeclineBookingWithoutRefund = async ({
  assetId,
  bookingId,
  renterId,
  adminId,
  notes,
}) =>
  updateBookingStatusAsAdmin({
    assetId,
    bookingId,
    renterId,
    adminId,
    notes,
    refundAmount: null,
    refundType: null,
    status: BOOKING_STATUS.declined,
    statusRequiresRefundReview: false,
  });

exports._test = {
  assertBookingCancellationRequestAllowed,
  buildCancellationApprovalOwnerNotification,
  buildCancellationApprovalOwnerChatText,
  buildCancellationApprovalRenterChatText,
  buildCancellationApprovalRenterNotification,
  buildCancellationRequestNotificationBody,
  buildCancellationSystemMessageData,
  buildOwnerCancellationPenaltyPreview,
  buildRenterCancellationPolicyPreview,
  buildCancellationRequestedChatUpdate,
  buildCancelledOwnerPayoutFlow,
  buildRecurringCancellationMessageId,
  calculateRetentionAmount,
  formatCancellationWindowLabel,
  getRenterCancellationRentalBase,
  getRenterCancellationSecurityDepositAmount,
  getRenterCancellationTotalRefundableAmount,
  getPaidBookingAmount,
  getPendingBookingDelta,
  isWithinOwnerCancellationPenaltyCutoff,
  isNonRefundablePaymentMethod,
  normalizeCancelReason,
  releaseRenterCancellationOwnerAmount,
  resolvePolicyWindowMs,
  resolveCancellationActorRole,
  resolveCancellationRefundPlan,
  setBookingMirrors,
  shouldCancelOwnerPayout,
  updateBookingMirrors,
};
