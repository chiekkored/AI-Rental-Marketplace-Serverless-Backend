const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  ACTIVE_BOOKING_STATUSES,
  BOOKING_STATUS,
  CHAT_STATUS,
  assertAssetMinimumNights,
  buildBookingMirrorUpdate,
  formatBookingPurpose,
  normalizeBookingRange,
  normalizeSecurityDeposit,
} = require("../utils/booking.util");
const { pendingBookingCountIncrementValue } = require("../utils/pendingBookingCount.util");
const { updateRecommendationProfile } = require("../utils/recommendations.util");
const { firstListingImageUrl, sendNotificationToUser } = require("../utils/notification.util");
const { sendBookingRequestEmails } = require("../utils/transactionalEmail.util");
const { assertUsersCanInteract } = require("../utils/userBlock.util");
const { assertUserCanReceiveNewBooking } = require("./account/deactivation");

function bookingOverlapOperators({ blocksEndDate }) {
  return blocksEndDate === true
    ? { startDateOperator: "<=", endDateOperator: ">=" }
    : { startDateOperator: "<", endDateOperator: ">" };
}

exports.createBookingRequest = async (request) => {
  const auth = request.auth;
  const { assetId, startDateMs, endDateMs, totalPrice } = request.data || {};

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (!assetId || startDateMs == null || endDateMs == null || totalPrice == null) {
    throwAndLogHttpsError("invalid-argument", "Missing assetId, startDateMs, endDateMs, or totalPrice");
  }

  const renterId = auth.uid;
  const bookingRange = normalizeBookingRange({
    startDate: startDateMs,
    endDate: endDateMs,
  });

  if (typeof totalPrice !== "number" || totalPrice <= 0) {
    throwAndLogHttpsError("invalid-argument", "Invalid totalPrice");
  }

  const db = admin.firestore();
  const assetRef = db.collection("assets").doc(assetId);
  const renterRef = db.collection("users").doc(renterId);

  const [assetSnap, renterSnap] = await Promise.all([assetRef.get(), renterRef.get()]);

  if (!assetSnap.exists) {
    throwAndLogHttpsError("not-found", "Asset not found");
  }

  if (!renterSnap.exists) {
    throwAndLogHttpsError("not-found", "Renter not found");
  }

  const asset = assetSnap.data();
  const renter = renterSnap.data();

  if (!asset || asset.isDeleted === true || asset.status !== "Available") {
    throwAndLogHttpsError("failed-precondition", "Asset is unavailable");
  }

  if (!["Basic", "Full"].includes(renter.verified)) {
    throwAndLogHttpsError("failed-precondition", "Verify your email before booking");
  }

  if (!asset.ownerId || !asset.owner) {
    throwAndLogHttpsError("failed-precondition", "Asset owner is missing");
  }

  if (asset.ownerId === renterId) {
    throwAndLogHttpsError("failed-precondition", "Owner cannot book their own asset");
  }

  await assertUserCanReceiveNewBooking(db, asset.ownerId);
  await assertUsersCanInteract(db, renterId, asset.ownerId, "You cannot book this owner's listings");

  assertAssetMinimumNights(asset, bookingRange);

  const assetBlocksEndDate = asset.blocksEndDate === true;
  const overlapOperators = bookingOverlapOperators({
    blocksEndDate: assetBlocksEndDate,
  });
  const overlapQuery = db
    .collection("assets")
    .doc(assetId)
    .collection("bookings");
  const overlapSnap = await overlapQuery
    .where("startDate", overlapOperators.startDateOperator, admin.firestore.Timestamp?.fromDate(bookingRange.endDate) || bookingRange.endDate)
    .where("endDate", overlapOperators.endDateOperator, admin.firestore.Timestamp?.fromDate(bookingRange.startDate) || bookingRange.startDate)
    .where("status", "in", ACTIVE_BOOKING_STATUSES)
    .limit(1)
    .get();

  if (!overlapSnap.empty) {
    throwAndLogHttpsError("already-exists", "Asset is unavailable for the selected dates");
  }

  const bookingRef = db.collection("users").doc(renterId).collection("bookings").doc();
  const rootBookingRef = db.collection("bookings").doc(bookingRef.id);
  const assetBookingRef = db.collection("assets").doc(assetId).collection("bookings").doc(bookingRef.id);
  const chatRef = db.collection("chats").doc();
  const messageRef = chatRef.collection("messages").doc();
  const renterUserChatRootRef = db.collection("userChats").doc(renterId);
  const renterUserChatRef = renterUserChatRootRef.collection("chats").doc(chatRef.id);
  const ownerUserChatRootRef = db.collection("userChats").doc(asset.ownerId);
  const ownerUserChatRef = ownerUserChatRootRef.collection("chats").doc(chatRef.id);
  const ownerAssetMirrorRef = db.collection("users").doc(asset.ownerId).collection("assets").doc(assetId);

  const renterSnapshot = toSimpleUser(renter, renterId);
  const assetSnapshot = toAssetSnapshot(asset, assetId);
  const securityDeposit = normalizeSecurityDeposit(asset.securityDeposit);
  const bookingText = formatBookingPurpose(
    { asset: assetSnapshot, startDate: bookingRange.startDate },
    "was requested.",
    "A booking",
  );

  const bookingPayload = {
    id: bookingRef.id,
    chatId: chatRef.id,
    asset: assetSnapshot,
    createdAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    startDate: admin.firestore.Timestamp?.fromDate(bookingRange.startDate) || bookingRange.startDate,
    endDate: admin.firestore.Timestamp?.fromDate(bookingRange.endDate) || bookingRange.endDate,
    numDays: bookingRange.numDays,
    paymentFlow: null,
    priceBreakdown: {
      rentalSubtotal: totalPrice,
      securityDepositAmount: securityDeposit.enabled ? securityDeposit.amount : 0,
      paymentAmount: null,
      currency: asset?.rates?.currency || "PHP",
    },
    renter: renterSnapshot,
    status: BOOKING_STATUS.pending,
    totalPrice,
    securityDeposit,
    depositFlow: {
      required: securityDeposit.enabled,
      amount: securityDeposit.enabled ? securityDeposit.amount : 0,
      status: securityDeposit.enabled ? "held" : "none",
      renterResponse: null,
    },
    disputeFlow: null,
    payoutFlow: null,
  };

  const chatPayload = {
    id: chatRef.id,
    chatId: chatRef.id,
    bookingId: bookingRef.id,
    renterId,
    bookingStartDate: bookingPayload.startDate,
    bookingEndDate: bookingPayload.endDate,
    bookingStatus: bookingPayload.status,
    asset: assetSnapshot,
    participants: [asset.owner, renterSnapshot],
    participantIds: [asset.ownerId, renterId],
    lastMessage: bookingText,
    lastMessageDate: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    lastMessageSenderId: "",
    createdAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    hasRead: false,
    status: CHAT_STATUS.active,
  };

  await db.runTransaction(async (transaction) => {
    const ownerAssetMirrorSnap = await transaction.get(ownerAssetMirrorRef);

    transaction.set(rootBookingRef, bookingPayload);
    transaction.set(bookingRef, buildBookingMirrorUpdate(bookingPayload));
    transaction.set(assetBookingRef, buildBookingMirrorUpdate(bookingPayload));
    transaction.set(chatRef, { chatType: "Private" });
    transaction.set(messageRef, {
      id: messageRef.id,
      text: bookingText,
      senderId: "",
      createdAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      type: "system",
      visibleTo: [renterId, asset.ownerId],
    });
    transaction.set(renterUserChatRootRef, { isOnline: true }, { merge: true });
    transaction.set(ownerUserChatRootRef, { isOnline: true }, { merge: true });
    transaction.set(renterUserChatRef, { ...chatPayload, otherParticipantId: asset.ownerId });
    transaction.set(ownerUserChatRef, { ...chatPayload, otherParticipantId: renterId });
    transaction.set(
      ownerAssetMirrorRef,
      {
        pendingBookingCount: pendingBookingCountIncrementValue({
          fieldValue: admin.firestore.FieldValue,
          currentValue: ownerAssetMirrorSnap.data()?.pendingBookingCount,
          delta: 1,
        }),
      },
      { merge: true },
    );
    transaction.set(
      assetRef,
      {
        engagement: {
          bookingRequestCount: admin.firestore?.FieldValue?.increment(1) || FieldValue.increment(1),
          lastEngagedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
        },
        popularityScore: admin.firestore?.FieldValue?.increment(5) || FieldValue.increment(5),
        recommendationScore: admin.firestore?.FieldValue?.increment(2) || FieldValue.increment(2),
      },
      { merge: true },
    );
    updateRecommendationProfile(transaction, db, {
      uid: renterId,
      asset: { ...assetSnapshot, ownerId: asset.ownerId },
      weight: 5,
      signalType: "bookingRequest",
    });
  });

  await sendNotificationToUser({
    uid: asset.ownerId,
    title: "Booking Request",
    body: `${formatBookingPurpose({ asset: assetSnapshot, startDate: bookingRange.startDate }, "was requested.", "A booking")}`,
    imageUrl: firstListingImageUrl(assetSnapshot),
    push: false,
    data: {
      type: "booking",
      chatId: chatRef.id,
      bookingId: bookingRef.id,
      assetId,
      senderId: renterId,
    },
  }).catch((error) => {
    console.warn(`[createBookingRequest] Failed to send notification: ${error.message}`);
  });

  await sendBookingRequestEmails({
    booking: bookingPayload,
    ownerId: asset.ownerId,
    renterId,
  });

  return {
    success: true,
    bookingId: bookingRef.id,
    chatId: chatRef.id,
    message: "Booking request created",
  };
};

function toSimpleUser(user, uid) {
  const displayName = resolveMarketplaceDisplayName(user);
  return {
    uid,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    displayName,
    photoUrl: user.photoUrl || null,
    verified: user.verified || "None",
    status: user.status || "Active",
    userMetadataVersion: user.userMetadataVersion || 1,
  };
}

function resolveMarketplaceDisplayName(user) {
  const businessName = typeof user?.businessRegistration?.businessName === "string"
    ? user.businessRegistration.businessName.trim()
    : "";
  const businessApproved = user?.businessRegistration?.status === "Approved";
  return user?.useBusinessNameForListingOwnerName === true && businessApproved && businessName
    ? businessName
    : null;
}

function toAssetSnapshot(asset, assetId) {
  return {
    ...asset,
    id: assetId,
    securityDeposit: normalizeSecurityDeposit(asset.securityDeposit),
    ownerInstructions: asset.ownerInstructions || null,
    blocksEndDate: asset.blocksEndDate === true,
  };
}

exports._test = {
  bookingOverlapOperators,
  toAssetSnapshot,
};
