const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");
const { createSignedToken } = require("./token.util");
const { throwAndLogHttpsError } = require("./error.util");

const BOOKING_STATUS = {
  pending: "Pending",
  confirmed: "Confirmed",
  handedOver: "HandedOver",
  returned: "Returned",
  completed: "Completed",
  declined: "Declined",
  cancelled: "Cancelled",
  cancellationRequested: "Cancellation Requested",
};

const SETTLEMENT_STATUS = {
  notReturned: "not_returned",
  awaitingOwnerAction: "awaiting_owner_action",
  damageDeductionRequested: "damage_deduction_requested",
  adminReviewRequired: "admin_review_required",
  supportPending: "support_pending",
  completed: "completed",
};

const DEPOSIT_STATUS = {
  none: "none",
  held: "held",
  awaitingRenterResponse: "awaiting_renter_response",
  adminReviewRequired: "admin_review_required",
  supportPending: "support_pending",
  returnProcessing: "return_processing",
  returned: "returned",
  partiallyReturned: "partially_returned",
  deducted: "deducted",
};

const DAMAGE_RESPONSE_STATUS = {
  awaitingRenterResponse: "awaiting_renter_response",
  accepted: "accepted",
  disputed: "disputed",
};

const ACTIVE_BOOKING_STATUSES = [
  BOOKING_STATUS.confirmed,
  BOOKING_STATUS.handedOver,
  BOOKING_STATUS.returned,
  BOOKING_STATUS.cancellationRequested,
];

const CHAT_STATUS = {
  active: "Active",
  archived: "Archived",
};

function parseFirestoreDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  return new Date(value);
}

function normalizeToDay(date) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
}

function exclusiveDayCount(startDate, endDate) {
  const normalizedStart = normalizeToDay(startDate);
  const normalizedEnd = normalizeToDay(endDate);

  if (normalizedEnd <= normalizedStart) {
    return 0;
  }

  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((normalizedEnd.getTime() - normalizedStart.getTime()) / millisecondsPerDay);
}

function normalizeBookingRange({ startDate, endDate }) {
  const parsedStart = parseFirestoreDate(startDate);
  const parsedEnd = parseFirestoreDate(endDate);

  if (!(parsedStart instanceof Date) || Number.isNaN(parsedStart.getTime())) {
    throwAndLogHttpsError("invalid-argument", "Invalid startDate");
  }

  if (!(parsedEnd instanceof Date) || Number.isNaN(parsedEnd.getTime())) {
    throwAndLogHttpsError("invalid-argument", "Invalid endDate");
  }

  const normalizedStart = normalizeToDay(parsedStart);
  const normalizedEnd = normalizeToDay(parsedEnd);
  const numDays = exclusiveDayCount(normalizedStart, normalizedEnd);

  if (numDays < 1) {
    throwAndLogHttpsError("invalid-argument", "End date must be after start date");
  }

  return {
    startDate: normalizedStart,
    endDate: normalizedEnd,
    numDays,
  };
}

function assetMinimumNights(asset) {
  const minimumNights = asset?.details?.minimumNights;
  return Number.isInteger(minimumNights) && minimumNights > 0
    ? minimumNights
    : null;
}

function assertAssetMinimumNights(asset, bookingRange) {
  const minimumNights = assetMinimumNights(asset);
  if (minimumNights != null && bookingRange?.numDays < minimumNights) {
    const unit = minimumNights === 1 ? "night" : "nights";
    throwAndLogHttpsError(
      "failed-precondition",
      `This listing requires a minimum stay of ${minimumNights} ${unit}`,
    );
  }
}

function assertCanonicalBookingRange(booking) {
  if (!booking?.startDate || !booking?.endDate || booking?.numDays == null) {
    throwAndLogHttpsError("failed-precondition", "Booking must have startDate, endDate, and numDays");
  }

  const range = normalizeBookingRange({
    startDate: booking.startDate,
    endDate: booking.endDate,
  });

  if (!Number.isInteger(booking.numDays) || booking.numDays !== range.numDays) {
    throwAndLogHttpsError("failed-precondition", "Booking numDays does not match startDate/endDate");
  }

  return range;
}

function addDays(date, days) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + days,
  ));
}

function getBookingRefs({ assetId, bookingId, renterId }) {
  return {
    rootBookingRef: admin.firestore().doc(`bookings/${bookingId}`),
    assetBookingRef: admin.firestore().doc(`assets/${assetId}/bookings/${bookingId}`),
    userBookingRef: admin.firestore().doc(`users/${renterId}/bookings/${bookingId}`),
  };
}

function getBookingActors(booking) {
  return {
    ownerId: booking?.asset?.owner?.uid || null,
    renterId: booking?.renter?.uid || null,
    chatId: booking?.chatId || null,
  };
}

function assertBookingOwner(authUid, booking) {
  const { ownerId } = getBookingActors(booking);

  if (!ownerId || authUid !== ownerId) {
    throwAndLogHttpsError("permission-denied", "Only the asset owner can perform this action");
  }
}

function assertBookingParticipant(authUid, booking) {
  const { ownerId, renterId } = getBookingActors(booking);

  if (!authUid || (authUid !== ownerId && authUid !== renterId)) {
    throwAndLogHttpsError("permission-denied", "Only booking participants can perform this action");
  }
}

function assertQrScannerAuthorized({ authUid, action, booking }) {
  const { ownerId, renterId } = getBookingActors(booking);

  if (action === "handover" && authUid !== renterId) {
    throwAndLogHttpsError("permission-denied", "Only the renter can verify handover");
  }

  if (action === "return" && authUid !== ownerId) {
    throwAndLogHttpsError("permission-denied", "Only the owner can verify return");
  }
}

function assertPendingBooking(booking) {
  if (booking?.status !== BOOKING_STATUS.pending) {
    throwAndLogHttpsError("failed-precondition", "Booking is no longer pending");
  }
}

function normalizeSecurityDeposit(input) {
  const enabled = input?.enabled === true;
  const amount = Number(input?.amount || 0);

  if (!enabled) {
    return {
      enabled: false,
      amount: 0,
    };
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("Security deposit amount must be a positive integer");
  }

  return {
    enabled: true,
    amount,
  };
}

function assertNotReturned(booking) {
  if (booking?.status === BOOKING_STATUS.returned || booking?.status === BOOKING_STATUS.completed) {
    throwAndLogHttpsError("failed-precondition", "Booking already returned");
  }
}

function assertReviewableBooking(booking) {
  if (booking?.status !== BOOKING_STATUS.returned && booking?.status !== BOOKING_STATUS.completed) {
    throwAndLogHttpsError("failed-precondition", "Booking must be returned or completed before submitting a review");
  }
}

function assertTokenGenerationAllowed(booking) {
  const allowedStatuses = [BOOKING_STATUS.confirmed, BOOKING_STATUS.handedOver];

  if (!allowedStatuses.includes(booking?.status)) {
    throwAndLogHttpsError("failed-precondition", "Booking is not eligible for QR token generation");
  }
}

function buildTokenBundle({ bookingId, renterId, assetId, endDate }) {
  const normalizedEndDate = parseFirestoreDate(endDate);

  if (!normalizedEndDate) {
    throwAndLogHttpsError("failed-precondition", "Booking must have endDate");
  }

  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  const handoverExpiry = new Date(normalizedEndDate.getTime());
  const returnExpiry = new Date(normalizedEndDate.getTime() + threeDaysMs);

  const handoverToken = createSignedToken({
    bookingId,
    userId: renterId,
    assetId,
    action: "handover",
    uuid: uuidv4(),
    expiresAt: handoverExpiry.getTime(),
  });

  const returnToken = createSignedToken({
    bookingId,
    userId: renterId,
    assetId,
    action: "return",
    uuid: uuidv4(),
    expiresAt: returnExpiry.getTime(),
  });

  return {
    handoverToken,
    returnToken,
    handoverExpiry,
    returnExpiry,
  };
}

function buildTokenUpdateData({ bookingId, renterId, assetId, endDate, existingTokens, markRegenerated = false }) {
  const bundle = buildTokenBundle({ bookingId, renterId, assetId, endDate });

  return {
    tokens: {
      handoverToken: bundle.handoverToken,
      returnToken: bundle.returnToken,
      handoverExpiry: admin.firestore.Timestamp?.fromDate(bundle.handoverExpiry) || bundle.handoverExpiry,
      returnExpiry: admin.firestore.Timestamp?.fromDate(bundle.returnExpiry) || bundle.handoverExpiry,
      createdAt: existingTokens?.createdAt || admin.firestore.FieldValue?.serverTimestamp() || new Date(),
      ...(markRegenerated ? { regeneratedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date() } : {}),
    },
    rawTokens: {
      handover: bundle.handoverToken,
      return: bundle.returnToken,
    },
    expiries: {
      handover: bundle.handoverExpiry.toISOString(),
      return: bundle.returnExpiry.toISOString(),
    },
  };
}

function getExpectedTokenForAction(tokens, action) {
  if (action === "handover") return tokens?.handoverToken || null;
  if (action === "return") return tokens?.returnToken || null;
  return null;
}

function getExpectedStatusForAction(action) {
  if (action === "handover") return BOOKING_STATUS.confirmed;
  if (action === "return") return BOOKING_STATUS.handedOver;
  throwAndLogHttpsError("invalid-argument", "Invalid token action");
}

function getTargetStatusForAction(action) {
  if (action === "handover") return BOOKING_STATUS.handedOver;
  if (action === "return") return BOOKING_STATUS.returned;
  throwAndLogHttpsError("invalid-argument", "Invalid token action");
}

function isTokenActionCompleted(booking, action) {
  const completedStatuses = {
    handover: [BOOKING_STATUS.handedOver, BOOKING_STATUS.returned, BOOKING_STATUS.completed],
    return: [BOOKING_STATUS.returned, BOOKING_STATUS.completed],
  };

  if (!completedStatuses[action]) {
    throwAndLogHttpsError("invalid-argument", "Invalid token action");
  }

  return completedStatuses[action].includes(booking?.status);
}

function assertTokenActionAvailable(booking, action) {
  if (isTokenActionCompleted(booking, action)) {
    throwAndLogHttpsError("already-exists", `${action} already completed for this booking`);
  }

  const expectedStatus = getExpectedStatusForAction(action);
  if (booking?.status !== expectedStatus) {
    throwAndLogHttpsError("failed-precondition", `Booking must be ${expectedStatus} before ${action}`);
  }
}

function isTokenActionAvailableOrCompleted(booking, action) {
  return isTokenActionCompleted(booking, action) || booking?.status === getExpectedStatusForAction(action);
}

function assertTokenActionAvailableOrCompleted(booking, action) {
  if (!isTokenActionAvailableOrCompleted(booking, action)) {
    throwAndLogHttpsError("failed-precondition", `Booking cannot perform ${action} from its current status`);
  }
}

function getLifecycleMessageId(eventName, bookingId) {
  if (!bookingId) {
    throwAndLogHttpsError("invalid-argument", "Missing bookingId");
  }

  return `booking-${eventName}-${bookingId}`;
}

function formatBookingStartDate(value) {
  const date = parseFirestoreDate(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function bookingAssetTitle(booking) {
  return booking?.asset?.title || booking?.assetTitle || null;
}

function bookingStartDate(booking) {
  return booking?.startDate || booking?.bookingStartDate || null;
}

function formatBookingSubject(booking, fallback = "Your booking") {
  const assetTitle = bookingAssetTitle(booking);
  const startDate = formatBookingStartDate(bookingStartDate(booking));
  if (assetTitle && startDate) return `${assetTitle} for ${startDate}`;
  if (assetTitle) return assetTitle;
  if (startDate) return `${fallback} for ${startDate}`;
  return fallback;
}

function formatBookingPurpose(booking, purpose, fallback = "Your booking") {
  return `${formatBookingSubject(booking, fallback)} ${purpose}`;
}

function buildBookingMirrorUpdate(booking, extra = {}) {
  return {
    id: booking.id,
    chatId: booking.chatId || null,
    asset: booking.asset || null,
    createdAt: booking.createdAt || null,
    startDate: booking.startDate || null,
    endDate: booking.endDate || null,
    numDays: booking.numDays ?? null,
    renter: booking.renter || null,
    status: booking.status || null,
    totalPrice: booking.totalPrice ?? null,
    tokens: booking.tokens || null,
    securityDeposit: booking.securityDeposit || null,
    paymentFlow: booking.paymentFlow || null,
    billingPlan: booking.billingPlan || null,
    priceBreakdown: booking.priceBreakdown || null,
    depositFlow: booking.depositFlow || null,
    disputeFlow: booking.disputeFlow || null,
    payoutFlow: booking.payoutFlow || null,
    lastUpdated: booking.lastUpdated || admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    ...extra,
  };
}

module.exports = {
  BOOKING_STATUS,
  SETTLEMENT_STATUS,
  DEPOSIT_STATUS,
  DAMAGE_RESPONSE_STATUS,
  ACTIVE_BOOKING_STATUSES,
  CHAT_STATUS,
  parseFirestoreDate,
  normalizeToDay,
  exclusiveDayCount,
  normalizeBookingRange,
  assetMinimumNights,
  assertAssetMinimumNights,
  assertCanonicalBookingRange,
  addDays,
  getBookingRefs,
  getBookingActors,
  assertBookingOwner,
  assertBookingParticipant,
  assertQrScannerAuthorized,
  assertPendingBooking,
  normalizeSecurityDeposit,
  assertNotReturned,
  assertReviewableBooking,
  assertTokenGenerationAllowed,
  buildTokenUpdateData,
  getExpectedTokenForAction,
  getExpectedStatusForAction,
  getTargetStatusForAction,
  isTokenActionCompleted,
  assertTokenActionAvailable,
  isTokenActionAvailableOrCompleted,
  assertTokenActionAvailableOrCompleted,
  getLifecycleMessageId,
  formatBookingStartDate,
  formatBookingSubject,
  formatBookingPurpose,
  buildBookingMirrorUpdate,
};
