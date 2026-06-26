const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  BOOKING_STATUS,
  CHAT_STATUS,
  assertReviewableBooking,
  getBookingRefs,
  getLifecycleMessageId,
} = require("../utils/booking.util");
const { updateRecommendationProfile } = require("../utils/recommendations.util");
const { FieldValue } = require("firebase-admin/firestore");

exports.submitBookingReview = async (request) => {
  const auth = request.auth;
  const { bookingId, assetId, chatId, rating, review } = request.data || {};

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (!bookingId || !assetId || !chatId || rating == null || review == null) {
    throwAndLogHttpsError("invalid-argument", "Missing bookingId, assetId, chatId, rating, or review");
  }

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throwAndLogHttpsError("invalid-argument", "Rating must be between 1 and 5");
  }

  if (typeof review !== "string") {
    throwAndLogHttpsError("invalid-argument", "Review must be a string");
  }

  const renterId = auth.uid;
  const trimmedReview = review.trim();
  const db = admin.firestore();
  const assetRef = db.collection("assets").doc(assetId);
  const assetRatingRef = assetRef.collection("ratings").doc(bookingId);
  const renterUserChatRef = db.collection("userChats").doc(renterId).collection("chats").doc(chatId);
  const { assetBookingRef, userBookingRef } = getBookingRefs({ assetId, bookingId, renterId });

  await db.runTransaction(async (transaction) => {
    const [assetSnap, ratingSnap, userBookingSnap, assetBookingSnap] = await Promise.all([
      transaction.get(assetRef),
      transaction.get(assetRatingRef),
      transaction.get(userBookingRef),
      transaction.get(assetBookingRef),
    ]);

    if (!assetSnap.exists) {
      throwAndLogHttpsError("not-found", "Asset not found");
    }

    if (!userBookingSnap.exists || !assetBookingSnap.exists) {
      throwAndLogHttpsError("not-found", "Booking not found");
    }

    const assetData = assetSnap.data() || {};
    const userBooking = userBookingSnap.data() || {};
    const assetBooking = assetBookingSnap.data() || {};
    const booking = userBookingSnap.data() || assetBookingSnap.data() || {};

    if (booking?.renter?.uid !== renterId) {
      throwAndLogHttpsError("permission-denied", "Only the renter can submit a review");
    }

    if (booking?.asset?.id !== assetId || booking?.chatId !== chatId) {
      throwAndLogHttpsError("failed-precondition", "Booking context does not match the selected chat or asset");
    }

    assertReviewableBooking(userBooking);
    assertReviewableBooking(assetBooking);

    if (ratingSnap.exists) {
      throwAndLogHttpsError("already-exists", "You have already reviewed this booking.");
    }

    const currentAverage = Number(assetData.averageRating || 0);
    const currentCount = Number(assetData.reviewCount || 0);
    const newCount = currentCount + 1;
    const newAverage = (currentAverage * currentCount + rating) / newCount;
    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();

    transaction.set(assetRatingRef, {
      rating,
      review: trimmedReview,
      userId: renterId,
      timestamp: now,
    });

    updateAssetRatingAggregate(transaction, assetRef, {
      averageRating: newAverage,
      reviewCount: newCount,
    });

    transaction.set(
      assetRef,
      {
        engagement: {
          reviewCount: admin.firestore?.FieldValue?.increment(1) || FieldValue.increment(1),
          lastEngagedAt: now,
        },
        qualityScore: newAverage * Math.min(newCount, 10),
        popularityScore: admin.firestore?.FieldValue?.increment(3) || FieldValue.increment(3),
        recommendationScore: admin.firestore?.FieldValue?.increment(2) || FieldValue.increment(2),
      },
      { merge: true },
    );

    transaction.update(userBookingRef, {
      status: BOOKING_STATUS.completed,
      lastUpdated: now,
    });

    transaction.update(assetBookingRef, {
      status: BOOKING_STATUS.completed,
      lastUpdated: now,
    });

    const event = {
      type: "review-submitted",
      actorId: renterId,
      fromStatus: BOOKING_STATUS.returned,
      toStatus: BOOKING_STATUS.completed,
      createdAt: now,
    };
    transaction.set(userBookingRef.collection("events").doc("review-submitted"), event, { merge: true });
    transaction.set(assetBookingRef.collection("events").doc("review-submitted"), event, { merge: true });

    transaction.set(
      renterUserChatRef,
      {
        status: CHAT_STATUS.archived,
        bookingStatus: BOOKING_STATUS.completed,
      },
      { merge: true },
    );
    updateRecommendationProfile(transaction, db, {
      uid: renterId,
      asset: {
        id: assetId,
        ownerId: assetData.ownerId || null,
        categoryId: assetData.categoryId || booking?.asset?.categoryId || null,
        categoryName:
          assetData.categoryName || booking?.asset?.categoryName || null,
      },
      weight: 4,
      signalType: "review",
    });
  });

  await db
    .collection("chats")
    .doc(chatId)
    .collection("messages")
    .doc(getLifecycleMessageId("rating-request", bookingId))
    .delete();

  return {
    success: true,
    message: "Review submitted successfully",
  };
};

function updateAssetRatingAggregate(transaction, assetRef, { averageRating, reviewCount }) {
  transaction._writeBatch._ops.push({
    docPath: assetRef.path,
    op: () => buildAssetRatingAggregateWrite(assetRef, { averageRating, reviewCount }),
  });
}

function buildAssetRatingAggregateWrite(assetRef, { averageRating, reviewCount }) {
  return {
    update: {
      name: assetRef.formattedName,
      fields: {
        averageRating: {
          doubleValue: averageRating,
        },
        reviewCount: {
          integerValue: reviewCount,
        },
      },
    },
    updateMask: {
      fieldPaths: ["averageRating", "reviewCount"],
    },
    currentDocument: {
      exists: true,
    },
  };
}

exports._test = {
  buildAssetRatingAggregateWrite,
};
