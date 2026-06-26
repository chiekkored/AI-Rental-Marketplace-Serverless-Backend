const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertCanonicalBookingRange,
  assertAssetMinimumNights,
  assertNotReturned,
  assertPendingBooking,
  assertReviewableBooking,
  assertTokenActionAvailable,
  assertTokenActionAvailableOrCompleted,
  assertTokenGenerationAllowed,
  BOOKING_STATUS,
  exclusiveDayCount,
  assetMinimumNights,
  formatBookingSubject,
  formatBookingPurpose,
  getLifecycleMessageId,
  getExpectedStatusForAction,
  getTargetStatusForAction,
  isTokenActionCompleted,
  normalizeToDay,
  normalizeBookingRange,
  addDays,
} = require("../utils/booking.util");
const {
  countPendingBookings,
  pendingBookingCountIncrementValue,
} = require("../utils/pendingBookingCount.util");
const {
  getDeclineOverlappingBookingsUrl,
  resolveProjectId,
} = require("../utils/task.util");
const {
  createSignedToken,
  validateSignedQrToken,
} = require("../utils/token.util");
const {
  _test: declineOverlappingBookingsTest,
} = require("../calls/declineOverlappingBookings");
const {
  _test: confirmBookingTest,
} = require("../calls/confirmBooking");
const {
  _test: cancelBookingTest,
} = require("../calls/cancelBooking");
const {
  _test: paymentBookingTest,
} = require("../calls/payment/utils/paymentFlow.util");
const {
  _test: remoteConfigTest,
} = require("../utils/remoteConfig.util");
const {
  _test: submitBookingReviewTest,
} = require("../calls/submitBookingReview");
const {
  _test: verifyAndMarkTest,
} = require("../calls/verifyAndMark");
const {
  _test: createBookingRequestTest,
} = require("../calls/createBookingRequest");

process.env.QR_SECRET = "test-secret";

const renterCancellationPolicy = remoteConfigTest.normalizePricingPolicyConfig(
  remoteConfigTest.DEFAULT_PRICING_POLICY,
).renterCancellationPolicy;

function withEnv(overrides, callback) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  try {
    return callback();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

test("exclusiveDayCount excludes the return boundary day", () => {
  assert.equal(
    exclusiveDayCount(
      new Date(Date.UTC(2026, 3, 10, 16, 0)),
      new Date(Date.UTC(2026, 3, 12, 9, 0)),
    ),
    2,
  );
});

test("debug QR bypass is available only in the functions emulator", () => {
  withEnv({ FUNCTIONS_EMULATOR: "true" }, () => {
    assert.equal(verifyAndMarkTest.isDebugQrBypassAllowed(), true);
    assert.doesNotThrow(() => verifyAndMarkTest.assertDebugQrBypassAllowed());
  });

  withEnv({ FUNCTIONS_EMULATOR: undefined }, () => {
    assert.equal(verifyAndMarkTest.isDebugQrBypassAllowed(), false);
    assert.throws(
      () => verifyAndMarkTest.assertDebugQrBypassAllowed(),
      /Debug QR bypass is only available in the functions emulator/,
    );
  });
});

test("exclusiveDayCount returns zero for same-day or reversed ranges", () => {
  assert.equal(
    exclusiveDayCount(
      new Date(Date.UTC(2026, 3, 10)),
      new Date(Date.UTC(2026, 3, 10)),
    ),
    0,
  );
  assert.equal(
    exclusiveDayCount(
      new Date(Date.UTC(2026, 3, 12)),
      new Date(Date.UTC(2026, 3, 10)),
    ),
    0,
  );
});

test("normalizeToDay strips time", () => {
  assert.deepEqual(
    normalizeToDay(new Date(Date.UTC(2026, 3, 10, 16, 30))),
    new Date(Date.UTC(2026, 3, 10)),
  );
});

test("addDays advances calendar days from the normalized date parts", () => {
  assert.deepEqual(
    addDays(new Date(Date.UTC(2026, 3, 30, 16, 30)), 1),
    new Date(Date.UTC(2026, 4, 1)),
  );
});

test("normalizeBookingRange enforces exclusive-end canonical ranges", () => {
  const range = normalizeBookingRange({
    startDate: new Date(Date.UTC(2026, 3, 10, 16, 30)),
    endDate: new Date(Date.UTC(2026, 3, 12, 9, 15)),
  });

  assert.deepEqual(range.startDate, new Date(Date.UTC(2026, 3, 10)));
  assert.deepEqual(range.endDate, new Date(Date.UTC(2026, 3, 12)));
  assert.equal(range.numDays, 2);

  assert.throws(
    () => normalizeBookingRange({
      startDate: new Date(Date.UTC(2026, 3, 12)),
      endDate: new Date(Date.UTC(2026, 3, 10)),
    }),
    /End date must be after start date/,
  );
});

test("asset minimum nights only recognizes positive integers", () => {
  assert.equal(assetMinimumNights({ details: { minimumNights: 3 } }), 3);
  assert.equal(assetMinimumNights({ details: { minimumNights: 0 } }), null);
  assert.equal(assetMinimumNights({ details: { minimumNights: -1 } }), null);
  assert.equal(assetMinimumNights({ details: { minimumNights: 2.5 } }), null);
  assert.equal(assetMinimumNights({ details: { minimumNights: "3" } }), null);
  assert.equal(assetMinimumNights({}), null);
});

test("assertAssetMinimumNights rejects booking ranges below the listing minimum", () => {
  assert.doesNotThrow(() => assertAssetMinimumNights(
    { details: { minimumNights: 3 } },
    { numDays: 3 },
  ));
  assert.doesNotThrow(() => assertAssetMinimumNights({}, { numDays: 1 }));
  assert.throws(
    () => assertAssetMinimumNights(
      { details: { minimumNights: 3 } },
      { numDays: 2 },
    ),
    /minimum stay of 3 nights/,
  );
});

test("create booking overlap operators preserve exclusive end-date by default", () => {
  assert.deepEqual(createBookingRequestTest.bookingOverlapOperators({
    blocksEndDate: false,
  }), {
    startDateOperator: "<",
    endDateOperator: ">",
  });
});

test("create booking overlap operators include boundary date when listing blocks end date", () => {
  assert.deepEqual(createBookingRequestTest.bookingOverlapOperators({
    blocksEndDate: true,
  }), {
    startDateOperator: "<=",
    endDateOperator: ">=",
  });
});

test("create booking request asset snapshot includes the complete asset", () => {
  const snapshot = createBookingRequestTest.toAssetSnapshot({
    id: "stale-id",
    ownerId: "owner-1",
    title: "Camera",
    description: "A camera available for events.",
    showcase: ["showcase-1"],
    inclusions: ["Battery"],
    details: { brand: "Canon" },
    securityDeposit: { enabled: true, amount: 5000 },
  }, "asset-1");

  assert.equal(snapshot.id, "asset-1");
  assert.equal(snapshot.ownerId, "owner-1");
  assert.equal(snapshot.description, "A camera available for events.");
  assert.deepEqual(snapshot.showcase, ["showcase-1"]);
  assert.deepEqual(snapshot.inclusions, ["Battery"]);
  assert.deepEqual(snapshot.details, { brand: "Canon" });
});

test("assertCanonicalBookingRange requires startDate, endDate, and matching numDays", () => {
  assert.doesNotThrow(() => assertCanonicalBookingRange({
    startDate: new Date(Date.UTC(2026, 3, 10)),
    endDate: new Date(Date.UTC(2026, 3, 12)),
    numDays: 2,
  }));

  assert.throws(
    () => assertCanonicalBookingRange({
      startDate: new Date(Date.UTC(2026, 3, 10)),
      endDate: new Date(Date.UTC(2026, 3, 12)),
    }),
    /Booking must have startDate, endDate, and numDays/,
  );

  assert.throws(
    () => assertCanonicalBookingRange({
      startDate: new Date(Date.UTC(2026, 3, 10)),
      endDate: new Date(Date.UTC(2026, 3, 12)),
      numDays: 3,
    }),
    /Booking numDays does not match startDate\/endDate/,
  );
});

test("countPendingBookings only counts pending booking documents", () => {
  assert.equal(
    countPendingBookings([
      { status: "Pending" },
      { status: "Confirmed" },
      { status: "Pending" },
      { status: "Declined" },
      {},
    ]),
    2,
  );
});

test("pendingBookingCountIncrementValue uses Firestore increment when available", () => {
  const sentinel = { type: "increment", delta: 1 };
  const fieldValue = {
    increment(delta) {
      assert.equal(delta, 1);
      return sentinel;
    },
  };

  assert.equal(
    pendingBookingCountIncrementValue({
      fieldValue,
      currentValue: 4,
      delta: 1,
    }),
    sentinel,
  );
});

test("pendingBookingCountIncrementValue falls back to current count plus delta", () => {
  assert.equal(
    pendingBookingCountIncrementValue({
      fieldValue: null,
      currentValue: 4,
      delta: 1,
    }),
    5,
  );
  assert.equal(
    pendingBookingCountIncrementValue({
      fieldValue: null,
      currentValue: 4,
      delta: -1,
    }),
    3,
  );
});

test("pendingBookingCountIncrementValue treats missing or invalid current values as zero", () => {
  for (const currentValue of [undefined, null, "4", Number.NaN, Infinity]) {
    assert.equal(
      pendingBookingCountIncrementValue({
        fieldValue: {},
        currentValue,
        delta: -1,
      }),
      -1,
    );
  }
});

test("validateSignedQrToken accepts a current signed QR payload", () => {
  const expiresAt = Date.now() + 60_000;
  const token = createSignedToken({
    bookingId: "booking-1",
    userId: "renter-1",
    assetId: "asset-1",
    action: "handover",
    uuid: "uuid-1",
    expiresAt,
  });

  const result = validateSignedQrToken({ token, nowMs: expiresAt - 1 });

  assert.equal(result.payload.bookingId, "booking-1");
  assert.equal(result.payload.action, "handover");
});

test("validateSignedQrToken rejects malformed, tampered, expired, and incomplete tokens", () => {
  assert.throws(
    () => validateSignedQrToken({ token: "not-a-token" }),
    /Malformed token/,
  );

  const expired = createSignedToken({
    bookingId: "booking-1",
    userId: "renter-1",
    assetId: "asset-1",
    action: "handover",
    uuid: "uuid-1",
    expiresAt: 1000,
  });
  assert.throws(
    () => validateSignedQrToken({ token: expired, nowMs: 1001 }),
    /QR token expired/,
  );

  const current = createSignedToken({
    bookingId: "booking-1",
    userId: "renter-1",
    assetId: "asset-1",
    action: "handover",
    uuid: "uuid-1",
    expiresAt: 2000,
  });
  assert.throws(
    () => validateSignedQrToken({ token: `${current}x`, nowMs: 1000 }),
    /Invalid token signature/,
  );

  const incomplete = createSignedToken({
    bookingId: "booking-1",
    userId: "renter-1",
    assetId: "asset-1",
    action: "handover",
  });
  assert.throws(
    () => validateSignedQrToken({ token: incomplete }),
    /Missing token fields/,
  );
});

test("token action helpers map status transitions and reject invalid actions consistently", () => {
  assert.equal(getExpectedStatusForAction("handover"), BOOKING_STATUS.confirmed);
  assert.equal(getTargetStatusForAction("handover"), BOOKING_STATUS.handedOver);
  assert.equal(getExpectedStatusForAction("return"), BOOKING_STATUS.handedOver);
  assert.equal(getTargetStatusForAction("return"), BOOKING_STATUS.returned);
  assert.equal(isTokenActionCompleted({ status: BOOKING_STATUS.handedOver }, "handover"), true);
  assert.equal(isTokenActionCompleted({ status: BOOKING_STATUS.returned }, "return"), true);
  assert.equal(isTokenActionCompleted({ status: BOOKING_STATUS.handedOver }, "return"), false);
  assert.throws(
    () => getTargetStatusForAction("cancel"),
    /Invalid token action/,
  );

  assert.doesNotThrow(() => assertTokenActionAvailable({ status: BOOKING_STATUS.confirmed }, "handover"));
  assert.doesNotThrow(() => assertTokenActionAvailable({ status: BOOKING_STATUS.handedOver }, "return"));
  assert.doesNotThrow(() => assertTokenActionAvailableOrCompleted({ status: BOOKING_STATUS.returned }, "return"));
  assert.throws(
    () => assertTokenActionAvailable({ status: BOOKING_STATUS.handedOver }, "handover"),
    /handover already completed/,
  );
  assert.throws(
    () => assertTokenActionAvailable({ status: BOOKING_STATUS.confirmed }, "return"),
    /Booking must be HandedOver before return/,
  );
});

test("lifecycle preconditions and message ids are deterministic", () => {
  assert.doesNotThrow(() => assertPendingBooking({ status: "Pending" }));
  assert.throws(
    () => assertPendingBooking({ status: "Confirmed" }),
    /Booking is no longer pending/,
  );

  assert.doesNotThrow(() => assertNotReturned({ status: BOOKING_STATUS.handedOver }));
  assert.throws(
    () => assertNotReturned({ status: BOOKING_STATUS.returned }),
    /Booking already returned/,
  );

  assert.doesNotThrow(() => assertReviewableBooking({ status: BOOKING_STATUS.returned }));
  assert.doesNotThrow(() => assertReviewableBooking({ status: BOOKING_STATUS.completed }));
  assert.throws(
    () => assertReviewableBooking({ status: BOOKING_STATUS.handedOver }),
    /Booking must be returned or completed before submitting a review/,
  );

  assert.doesNotThrow(() => assertTokenGenerationAllowed({ status: BOOKING_STATUS.confirmed }));
  assert.doesNotThrow(() => assertTokenGenerationAllowed({ status: BOOKING_STATUS.handedOver }));
  assert.throws(
    () => assertTokenGenerationAllowed({ status: BOOKING_STATUS.returned }),
    /Booking is not eligible for QR token generation/,
  );

  assert.equal(getLifecycleMessageId("confirmed", "booking-1"), "booking-confirmed-booking-1");
  assert.equal(getLifecycleMessageId("handover", "booking-1"), "booking-handover-booking-1");
  assert.equal(getLifecycleMessageId("return", "booking-1"), "booking-return-booking-1");
  assert.equal(getLifecycleMessageId("rating-prompt", "booking-1"), "booking-rating-prompt-booking-1");
});

test("decline overlap payload normalizes canonical ranges", () => {
  const payload = declineOverlappingBookingsTest.normalizeOverlapPayload({
    assetId: "asset-1",
    selectedBookingId: "booking-1",
    startDate: new Date(Date.UTC(2026, 3, 10, 16, 30)).getTime(),
    endDate: new Date(Date.UTC(2026, 3, 12, 9, 0)).getTime(),
  });

  assert.equal(payload.assetId, "asset-1");
  assert.equal(payload.selectedBookingId, "booking-1");
  assert.deepEqual(payload.range.startDate, new Date(Date.UTC(2026, 3, 10)));
  assert.deepEqual(payload.range.endDate, new Date(Date.UTC(2026, 3, 12)));
  assert.equal(payload.range.numDays, 2);

  assert.throws(
    () => declineOverlappingBookingsTest.normalizeOverlapPayload({
      assetId: "asset-1",
      selectedBookingId: "booking-1",
    }),
    /Missing required fields/,
  );
});

test("decline overlap summary classifies partial mirror failures", () => {
  const summary = declineOverlappingBookingsTest.summarizeDeclineResults([
    { bookingId: "selected", status: "skipped_selected" },
    { bookingId: "declined", status: "declined" },
    {
      bookingId: "partial",
      status: "declined_with_missing_mirrors",
      missing: ["renterChat"],
    },
    { bookingId: "failed", status: "failed" },
  ]);

  assert.deepEqual(summary, {
    declinedCount: 2,
    skippedCount: 1,
    missingMirrorCount: 1,
    errorCount: 1,
  });
});

test("confirm booking rejects active overlapping bookings", () => {
  assert.doesNotThrow(() => confirmBookingTest.assertNoActiveOverlap({ empty: true }));
  assert.throws(
    () => confirmBookingTest.assertNoActiveOverlap({ empty: false }),
    /This booking overlaps an active booking/,
  );
});

test("decline task target points to functions emulator when enabled", () => {
  withEnv(
    {
      FUNCTIONS_EMULATOR: "true",
      GCP_PROJECT: undefined,
      GCLOUD_PROJECT: "lend-54b2e",
      FIREBASE_CONFIG: undefined,
      FUNCTIONS_EMULATOR_HOST: undefined,
      FUNCTIONS_EMULATOR_PORT: undefined,
    },
    () => {
      assert.equal(resolveProjectId(), "lend-54b2e");
      assert.equal(
        getDeclineOverlappingBookingsUrl(),
        "http://127.0.0.1:5001/lend-54b2e/asia-southeast1/declineOverlappingBookings",
      );
    },
  );
});

test("decline task target uses deployed URL outside emulator", () => {
  withEnv(
    {
      FUNCTIONS_EMULATOR: undefined,
      GCP_PROJECT: "lend-54b2e",
      GCLOUD_PROJECT: undefined,
      FIREBASE_CONFIG: undefined,
    },
    () => {
      assert.equal(
        getDeclineOverlappingBookingsUrl(),
        "https://asia-southeast1-lend-54b2e.cloudfunctions.net/declineOverlappingBookings",
      );
    },
  );
});

test("decline task omits oidc token for emulator target", () => {
  const task = confirmBookingTest.buildDeclineTask({
    assetId: "asset-1",
    selectedBookingId: "booking-1",
    startDate: 1775750400000,
    endDate: 1775923200000,
    project: "lend-54b2e",
    url: "http://127.0.0.1:5001/lend-54b2e/asia-southeast1/declineOverlappingBookings",
    includeOidcToken: false,
  });

  assert.equal(task.httpRequest.oidcToken, undefined);
  assert.equal(
    task.httpRequest.url,
      "http://127.0.0.1:5001/lend-54b2e/asia-southeast1/declineOverlappingBookings",
  );
  assert.deepEqual(
    JSON.parse(Buffer.from(task.httpRequest.body, "base64").toString("utf8")),
    {
      assetId: "asset-1",
      selectedBookingId: "booking-1",
      startDate: 1775750400000,
      endDate: 1775923200000,
    },
  );
});

test("decline task includes oidc token for production target", () => {
  withEnv(
    {
      TASKS_SERVICE_ACCOUNT_EMAIL: "tasks@lend-54b2e.iam.gserviceaccount.com",
    },
    () => {
      const task = confirmBookingTest.buildDeclineTask({
        assetId: "asset-1",
        selectedBookingId: "booking-1",
        startDate: 1775750400000,
        endDate: 1775923200000,
        project: "lend-54b2e",
        url: "https://declineoverlappingbookings-5d4s7snsja-uc.a.run.app",
        includeOidcToken: true,
      });

      assert.deepEqual(task.httpRequest.oidcToken, {
        serviceAccountEmail: "tasks@lend-54b2e.iam.gserviceaccount.com",
        audience: "https://declineoverlappingbookings-5d4s7snsja-uc.a.run.app",
      });
    },
  );
});

test("cancel booking reason is required and normalized", () => {
  assert.equal(cancelBookingTest.normalizeCancelReason("  Found another listing  "), "Found another listing");
  assert.throws(
    () => cancelBookingTest.normalizeCancelReason(""),
    /Missing cancellation reason/,
  );
  assert.throws(
    () => cancelBookingTest.normalizeCancelReason("x".repeat(121)),
    /Cancellation reason is too long/,
  );
});

test("cancellation mirror update writes root, asset, and user booking docs", () => {
  const writes = [];
  const refs = {
    rootBookingRef: { path: "bookings/booking-1" },
    assetBookingRef: { path: "assets/asset-1/bookings/booking-1" },
    userBookingRef: { path: "users/renter-1/bookings/booking-1" },
  };
  const updateData = {
    status: BOOKING_STATUS.cancellationRequested,
    cancellationRequest: { status: "Pending" },
  };
  const tx = {
    update(ref, data) {
      writes.push({ data, method: "update", path: ref.path });
    },
  };

  cancelBookingTest.updateBookingMirrors(tx, refs, updateData);

  assert.deepEqual(writes, [
    { data: updateData, method: "update", path: "bookings/booking-1" },
    { data: updateData, method: "update", path: "assets/asset-1/bookings/booking-1" },
    { data: updateData, method: "update", path: "users/renter-1/bookings/booking-1" },
  ]);
});

test("cancellation mirror set merges root, asset, and user booking docs", () => {
  const writes = [];
  const refs = {
    rootBookingRef: { path: "bookings/booking-1" },
    assetBookingRef: { path: "assets/asset-1/bookings/booking-1" },
    userBookingRef: { path: "users/renter-1/bookings/booking-1" },
  };
  const updateData = {
    payment: { refundStatus: "processing" },
    status: BOOKING_STATUS.cancelled,
  };
  const tx = {
    set(ref, data, options) {
      writes.push({ data, method: "set", options, path: ref.path });
    },
  };

  cancelBookingTest.setBookingMirrors(tx, refs, updateData);

  assert.deepEqual(writes, [
    { data: updateData, method: "set", options: { merge: true }, path: "bookings/booking-1" },
    { data: updateData, method: "set", options: { merge: true }, path: "assets/asset-1/bookings/booking-1" },
    { data: updateData, method: "set", options: { merge: true }, path: "users/renter-1/bookings/booking-1" },
  ]);
});

test("cancellation request keeps chat active while admin review is pending", () => {
  const now = new Date("2026-05-01T00:00:00.000Z");
  const messageText = "Cancellation requested. This booking is under admin review.";

  assert.deepEqual(
    cancelBookingTest.buildCancellationRequestedChatUpdate({ messageText, now }),
    {
      bookingStatus: BOOKING_STATUS.cancellationRequested,
      status: "Active",
      hasRead: false,
      lastMessage: messageText,
      lastMessageDate: now,
      lastMessageSenderId: "",
      lastUpdated: now,
    },
  );
});

test("recurring cancellation system messages use unique appendable ids", () => {
  const firstId = cancelBookingTest.buildRecurringCancellationMessageId({
    bookingId: "booking-1",
    eventName: "cancellation-requested",
    uniqueId: "request-1",
  });
  const secondId = cancelBookingTest.buildRecurringCancellationMessageId({
    bookingId: "booking-1",
    eventName: "cancellation-requested",
    uniqueId: "request-2",
  });

  assert.equal(firstId, "booking-cancellation-requested-booking-1-request-1");
  assert.equal(secondId, "booking-cancellation-requested-booking-1-request-2");
  assert.notEqual(firstId, secondId);
});

test("cancellation system message data is visible to both booking parties", () => {
  const now = new Date("2026-05-01T00:00:00.000Z");

  assert.deepEqual(
    cancelBookingTest.buildCancellationSystemMessageData({
      messageId: "booking-cancellation-requested-booking-1-request-1",
      messageText: "Owner requested cancellation. This booking is under admin review.",
      now,
      renterId: "renter-1",
      ownerId: "owner-1",
    }),
    {
      id: "booking-cancellation-requested-booking-1-request-1",
      text: "Owner requested cancellation. This booking is under admin review.",
      senderId: "",
      createdAt: now,
      type: "system",
      visibleTo: ["renter-1", "owner-1"],
    },
  );
});

test("cancellation approval system messages can be restricted by audience", () => {
  const now = new Date("2026-05-01T00:00:00.000Z");

  assert.deepEqual(
    cancelBookingTest.buildCancellationSystemMessageData({
      messageId: "booking-cancellation-approved-booking-1-renter-1",
      messageText: "Cancellation approved. Refund handling has started.",
      now,
      renterId: "renter-1",
      ownerId: "owner-1",
      visibleTo: ["renter-1"],
    }),
    {
      id: "booking-cancellation-approved-booking-1-renter-1",
      text: "Cancellation approved. Refund handling has started.",
      senderId: "",
      createdAt: now,
      type: "system",
      visibleTo: ["renter-1"],
    },
  );
});

test("cancellation approval chat text hides owner-sensitive details from renter", () => {
  const ownerText = cancelBookingTest.buildCancellationApprovalOwnerChatText({
    ownerPenalty: {
      currency: "PHP",
      penaltyAmount: 500,
    },
    refundPlan: { type: "full" },
    renterPenalty: null,
  });
  const renterText = cancelBookingTest.buildCancellationApprovalRenterChatText({
    refundPlan: { amount: 1200, type: "full" },
  });

  assert.match(ownerText, /deducted from future payouts/);
  assert.equal(renterText, "Cancellation approved. Refund handling has started.");
  assert.doesNotMatch(renterText, /deducted|penalty|future payouts|retained cancellation balance/i);
});

test("renter-requested cancellation approval hides retained balance from renter", () => {
  const ownerText = cancelBookingTest.buildCancellationApprovalOwnerChatText({
    ownerPenalty: null,
    refundPlan: { amount: 250, type: "partial" },
    renterPenalty: {
      currency: "PHP",
      refundAmount: 250,
      retainedOwnerAmount: 1000,
    },
  });
  const renterText = cancelBookingTest.buildCancellationApprovalRenterChatText({
    refundPlan: { amount: 250, type: "partial" },
  });

  assert.match(ownerText, /retained cancellation balance/);
  assert.equal(renterText, "Cancellation approved. Refund handling has started.");
  assert.doesNotMatch(renterText, /retained|released to the owner|owner/i);
});

test("renter-requested cancellation owner chat omits zero refund amount", () => {
  const ownerText = cancelBookingTest.buildCancellationApprovalOwnerChatText({
    ownerPenalty: null,
    refundPlan: { amount: 0, type: "none" },
    renterPenalty: {
      currency: "PHP",
      refundAmount: 0,
      retainedOwnerAmount: 1000,
    },
  });

  assert.equal(
    ownerText,
    "Cancellation approved. Refund handling has started. The retained cancellation balance will be released to the owner.",
  );
  assert.doesNotMatch(ownerText, /PHP 0|will be refunded to the renter/);
  assert.match(ownerText, /retained cancellation balance/);
});

test("renter-requested full refund approval gives owner cancellation-only chat text", () => {
  const ownerText = cancelBookingTest.buildCancellationApprovalOwnerChatText({
    ownerPenalty: null,
    refundPlan: { amount: 1200, type: "full" },
    renterPenalty: {
      currency: "PHP",
      refundAmount: 1200,
      retainedOwnerAmount: 0,
    },
  });

  assert.equal(ownerText, "Cancellation approved. The booking has been cancelled.");
  assert.doesNotMatch(ownerText, /refund processing|refund handling/i);
});

test("full refund cancellation marks owner payout as cancelled", () => {
  assert.equal(
    cancelBookingTest.shouldCancelOwnerPayout({
      refundPlan: { type: "full", retainedOwnerAmount: 0 },
    }),
    true,
  );
  assert.deepEqual(
    cancelBookingTest.buildCancelledOwnerPayoutFlow({
      payoutFlow: {
        ownerPayoutStatus: "pending",
        depositReturnStatus: "pending",
      },
    }),
    {
      ownerPayoutStatus: "cancelled",
      ownerPayoutAmount: 0,
      depositReturnStatus: "pending",
    },
  );
});

test("renter cancellation with retained owner amount does not cancel owner payout", () => {
  assert.equal(
    cancelBookingTest.shouldCancelOwnerPayout({
      refundPlan: { type: "partial", retainedOwnerAmount: 1000 },
      renterPenalty: { retainedOwnerAmount: 1000 },
    }),
    false,
  );
  assert.equal(
    cancelBookingTest.shouldCancelOwnerPayout({
      refundPlan: { type: "full", retainedOwnerAmount: 0 },
      renterPenalty: { retainedOwnerAmount: 1000 },
    }),
    false,
  );
});

test("cancellation request eligibility allows only pre-start pending or confirmed renter bookings", () => {
  const now = new Date("2026-05-01T00:00:00.000Z");
  const futureStart = new Date("2026-05-02T00:00:00.000Z");

  assert.doesNotThrow(() => cancelBookingTest.assertBookingCancellationRequestAllowed({
    booking: {
      status: BOOKING_STATUS.pending,
      startDate: futureStart,
    },
    actorRole: "renter",
    now,
  }));
  assert.doesNotThrow(() => cancelBookingTest.assertBookingCancellationRequestAllowed({
    booking: {
      status: BOOKING_STATUS.confirmed,
      startDate: futureStart,
    },
    actorRole: "renter",
    now,
  }));
  assert.throws(
    () => cancelBookingTest.assertBookingCancellationRequestAllowed({
      booking: {
        status: BOOKING_STATUS.handedOver,
        startDate: futureStart,
      },
      actorRole: "renter",
      now,
    }),
    /not eligible/,
  );
  assert.throws(
    () => cancelBookingTest.assertBookingCancellationRequestAllowed({
      booking: {
        status: BOOKING_STATUS.confirmed,
        startDate: now,
      },
      actorRole: "renter",
      now,
    }),
    /already active/,
  );
  assert.throws(
    () => cancelBookingTest.assertBookingCancellationRequestAllowed({
      booking: {
        status: BOOKING_STATUS.confirmed,
        startDate: futureStart,
        cancellationRequest: { status: "Pending" },
      },
      actorRole: "renter",
      now,
    }),
    /already under review/,
  );
});

test("owner cancellation request eligibility allows only confirmed bookings before handover", () => {
  assert.doesNotThrow(() => cancelBookingTest.assertBookingCancellationRequestAllowed({
    booking: { status: BOOKING_STATUS.confirmed },
    actorRole: "owner",
    now: new Date("2026-05-01T00:00:00.000Z"),
  }));
  assert.throws(
    () => cancelBookingTest.assertBookingCancellationRequestAllowed({
      booking: { status: BOOKING_STATUS.pending },
      actorRole: "owner",
      now: new Date("2026-05-01T00:00:00.000Z"),
    }),
    /Owner can only request cancellation/,
  );
  assert.throws(
    () => cancelBookingTest.assertBookingCancellationRequestAllowed({
      booking: { status: BOOKING_STATUS.handedOver },
      actorRole: "owner",
      now: new Date("2026-05-01T00:00:00.000Z"),
    }),
    /Owner can only request cancellation/,
  );
});

test("owner cancellation penalty is 50 percent before cutoff and 100 percent within 48 hours", () => {
  const booking = {
    startDate: new Date("2026-05-05T00:00:00.000Z"),
    paymentFlow: { currency: "PHP" },
    priceBreakdown: { ownerPayoutAmount: 1000 },
  };

  assert.deepEqual(
    cancelBookingTest.buildOwnerCancellationPenaltyPreview({
      booking,
      requestedAt: new Date("2026-05-02T23:59:59.000Z"),
    }),
    {
      type: "owner_cancellation",
      status: "open",
      penaltyRate: 0.5,
      penaltyBaseAmount: 1000,
      penaltyAmount: 500,
      remainingAmount: 500,
      currency: "PHP",
      cutoffHours: 48,
      listingStatusAfterApproval: "Under Maintenance",
    },
  );

  assert.deepEqual(
    cancelBookingTest.buildOwnerCancellationPenaltyPreview({
      booking,
      requestedAt: new Date("2026-05-03T00:00:00.000Z"),
    }),
    {
      type: "owner_cancellation",
      status: "open",
      penaltyRate: 1,
      penaltyBaseAmount: 1000,
      penaltyAmount: 1000,
      remainingAmount: 1000,
      currency: "PHP",
      cutoffHours: 48,
      listingStatusAfterApproval: "Under Maintenance",
    },
  );
});

test("owner cancellation penalty preserves decimal precision", () => {
  const booking = {
    startDate: new Date("2026-05-05T00:00:00.000Z"),
    paymentFlow: { currency: "PHP" },
    priceBreakdown: { ownerPayoutAmount: 1000.125 },
  };

  const preview = cancelBookingTest.buildOwnerCancellationPenaltyPreview({
    booking,
    requestedAt: new Date("2026-05-02T23:59:59.000Z"),
  });

  assert.equal(preview.penaltyBaseAmount, 1000.125);
  assert.equal(preview.penaltyAmount, 500.0625);
  assert.equal(preview.remainingAmount, 500.0625);
});

test("cancellation refund plan supports full and partial refunds", () => {
  const booking = {
    paymentFlow: {
      amount: 1200,
      method: "card",
    },
  };

  assert.deepEqual(
    cancelBookingTest.resolveCancellationRefundPlan({
      booking,
      refundAmount: null,
      refundType: "full",
    }),
    {
      amount: 1200,
      status: "processing",
      type: "full",
      retainedOwnerAmount: 0,
    },
  );

  assert.deepEqual(
    cancelBookingTest.resolveCancellationRefundPlan({
      booking,
      refundAmount: 500,
      refundType: "partial",
    }),
    {
      amount: 500,
      status: "processing",
      type: "partial",
    },
  );
});

test("renter cancellation policy gives full refund inside the shorter full-refund window", () => {
  const booking = {
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    startDate: new Date("2026-05-31T00:00:00.000Z"),
    totalPrice: 3000,
    securityDeposit: { enabled: true, amount: 500 },
    payment: { currency: "PHP" },
  };

  const preview = cancelBookingTest.buildRenterCancellationPolicyPreview({
    booking,
    policy: renterCancellationPolicy,
    requestedAt: new Date("2026-05-07T23:59:00.000Z"),
  });

  assert.equal(preview.tier, "full_refund");
  assert.equal(preview.refundBaseAmount, 3000);
  assert.equal(preview.rentalRefundAmount, 3000);
  assert.equal(preview.securityDepositRefundAmount, 500);
  assert.equal(preview.refundAmount, 3500);
  assert.equal(preview.retainedOwnerAmount, 0);
  assert.equal(preview.suggestedRefundType, "full");
  assert.equal(preview.fullRefundWindowLabel, "7 days");
  assert.equal(preview.noRefundWindowLabel, "2 days");
});

test("renter cancellation policy gives half refund after grace and no refund inside final window", () => {
  const booking = {
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    startDate: new Date("2026-05-31T00:00:00.000Z"),
    totalPrice: 3000,
    securityDeposit: { enabled: true, amount: 500 },
    payment: { currency: "PHP", method: "card" },
  };

  const partial = cancelBookingTest.buildRenterCancellationPolicyPreview({
    booking,
    policy: renterCancellationPolicy,
    requestedAt: new Date("2026-05-10T00:00:00.000Z"),
  });
  const late = cancelBookingTest.buildRenterCancellationPolicyPreview({
    booking,
    policy: renterCancellationPolicy,
    requestedAt: new Date("2026-05-30T00:00:00.000Z"),
  });

  assert.equal(partial.tier, "partial_refund");
  assert.equal(partial.rentalRefundAmount, 1500);
  assert.equal(partial.securityDepositRefundAmount, 500);
  assert.equal(partial.refundAmount, 2000);
  assert.equal(partial.retainedOwnerAmount, 1500);
  assert.equal(partial.suggestedRefundType, "partial");
  assert.equal(late.tier, "no_refund");
  assert.equal(late.rentalRefundAmount, 0);
  assert.equal(late.securityDepositRefundAmount, 500);
  assert.equal(late.refundAmount, 500);
  assert.equal(late.retainedOwnerAmount, 3000);
  assert.equal(late.suggestedRefundType, "partial");
});

test("renter cancellation policy rounds short windows as hours", () => {
  const booking = {
    createdAt: new Date("2026-04-30T10:00:00.000Z"),
    startDate: new Date("2026-05-02T06:00:00.000Z"),
    totalPrice: 1000,
    payment: { currency: "PHP" },
  };

  const preview = cancelBookingTest.buildRenterCancellationPolicyPreview({
    booking,
    policy: renterCancellationPolicy,
    requestedAt: new Date("2026-04-30T12:00:00.000Z"),
  });

  assert.equal(preview.fullRefundWindowLabel, "8 hours");
  assert.equal(preview.noRefundWindowLabel, "3 hours");
});

test("renter cancellation policy formats cancellation window labels at the 24-hour boundary", () => {
  assert.equal(cancelBookingTest.formatCancellationWindowLabel(23 * 60 * 60 * 1000), "23 hours");
  assert.equal(cancelBookingTest.formatCancellationWindowLabel(24 * 60 * 60 * 1000), "1 day");
});

test("renter cancellation policy makes bookings created under 24 hours before start non-refundable", () => {
  const booking = {
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    startDate: new Date("2026-05-02T00:00:00.000Z"),
    totalPrice: 1000,
    securityDeposit: { enabled: true, amount: 250 },
    payment: { currency: "PHP", method: "card" },
  };

  const preview = cancelBookingTest.buildRenterCancellationPolicyPreview({
    booking,
    policy: renterCancellationPolicy,
    requestedAt: new Date("2026-05-01T00:01:00.000Z"),
  });

  assert.equal(preview.tier, "no_refund");
  assert.equal(preview.shortLeadNoRefund, true);
  assert.equal(preview.rentalRefundAmount, 0);
  assert.equal(preview.securityDepositRefundAmount, 250);
  assert.equal(preview.refundAmount, 250);
  assert.equal(preview.suggestedRefundType, "partial");
  assert.equal(preview.retainedOwnerAmount, 1000);
  assert.equal(preview.noRefundWindowLabel, "16 hours");
  assert.equal(preview.noRefundStartsAt.getTime(), booking.createdAt.getTime());
});

test("renter cancellation policy uses Philippine midnight for date-only booking starts", () => {
  const booking = {
    createdAt: new Date("2026-05-27T19:16:00.000Z"), // May 28 3:16 AM Asia/Manila.
    startDate: new Date("2026-05-29T00:00:00.000Z"),
    totalPrice: 1000,
    securityDeposit: { enabled: true, amount: 250 },
    payment: { currency: "PHP", method: "card" },
  };

  const preview = cancelBookingTest.buildRenterCancellationPolicyPreview({
    booking,
    policy: renterCancellationPolicy,
    requestedAt: new Date("2026-05-27T19:17:00.000Z"),
  });

  assert.equal(preview.tier, "no_refund");
  assert.equal(preview.shortLeadNoRefund, true);
  assert.equal(preview.rentalRefundAmount, 0);
  assert.equal(preview.securityDepositRefundAmount, 250);
  assert.equal(preview.refundAmount, 250);
  assert.equal(preview.noRefundWindowLabel, "21 hours");
  assert.equal(preview.noRefundStartsAt.getTime(), booking.createdAt.getTime());
});

test("admin status refund helpers classify paid amounts and pending count changes", () => {
  assert.equal(cancelBookingTest.getPaidBookingAmount({ paymentFlow: { amount: 1200 } }), 1200);
  assert.equal(cancelBookingTest.getPaidBookingAmount({ totalPrice: 450 }), 450);
  assert.equal(cancelBookingTest.getPaidBookingAmount({ payment: { amount: 0 }, totalPrice: 0 }), 0);
  assert.equal(cancelBookingTest.getPendingBookingDelta("Pending", "Cancelled"), -1);
  assert.equal(cancelBookingTest.getPendingBookingDelta("Confirmed", "Pending"), 1);
  assert.equal(cancelBookingTest.getPendingBookingDelta("Confirmed", "Cancelled"), 0);
});

test("cancellation approval renter notification describes refund result", () => {
  const booking = {
    asset: { title: "Camera" },
    startDate: new Date(Date.UTC(2026, 3, 10)),
    payment: { currency: "PHP" },
  };

  assert.deepEqual(
    cancelBookingTest.buildCancellationApprovalRenterNotification({
      booking,
      refundPlan: { amount: 1200, type: "full" },
      renterId: "renter-1",
      chatId: "chat-1",
      bookingId: "booking-1",
      assetId: "asset-1",
      senderId: "admin-1",
    }),
    {
      uid: "renter-1",
      title: "Cancellation and Refund approved",
      body: "Camera for Apr 10, 2026 cancellation was approved. Full refund approved: PHP 1200.",
      imageUrl: null,
      push: false,
      data: {
        type: "booking",
        chatId: "chat-1",
        bookingId: "booking-1",
        assetId: "asset-1",
        senderId: "admin-1",
      },
    },
  );

  assert.equal(
    cancelBookingTest.buildCancellationApprovalRenterNotification({
      booking,
      refundPlan: { amount: 500, type: "partial" },
      renterId: "renter-1",
      chatId: "chat-1",
      bookingId: "booking-1",
      assetId: "asset-1",
      senderId: "admin-1",
    }).body,
    "Camera for Apr 10, 2026 cancellation was approved. Partial refund approved: PHP 500.",
  );

  assert.deepEqual(
    cancelBookingTest.buildCancellationApprovalRenterNotification({
      booking,
      refundPlan: { amount: 0, type: "none" },
      renterId: "renter-1",
      chatId: "chat-1",
      bookingId: "booking-1",
      assetId: "asset-1",
      senderId: "admin-1",
    }),
    {
      uid: "renter-1",
      title: "Cancellation approved",
      body: "Camera for Apr 10, 2026 cancellation was approved, but this payment method is not refundable.",
      imageUrl: null,
      push: false,
      data: {
        type: "booking",
        chatId: "chat-1",
        bookingId: "booking-1",
        assetId: "asset-1",
        senderId: "admin-1",
      },
    },
  );
});

test("cancellation approval owner notification describes future payout deduction", () => {
  const booking = {
    asset: { title: "Camera" },
    startDate: new Date(Date.UTC(2026, 3, 10)),
  };

  assert.deepEqual(
    cancelBookingTest.buildCancellationApprovalOwnerNotification({
      booking,
      ownerPenalty: {
        currency: "PHP",
        penaltyAmount: 500,
      },
      ownerId: "owner-1",
      chatId: "chat-1",
      bookingId: "booking-1",
      assetId: "asset-1",
      senderId: "admin-1",
    }),
    {
      uid: "owner-1",
      title: "Cancellation approved",
      body:
        "Camera for Apr 10, 2026 cancellation was approved. PHP 500 will be deducted from future payouts for this listing.",
      imageUrl: null,
      push: false,
      data: {
        type: "booking",
        chatId: "chat-1",
        bookingId: "booking-1",
        assetId: "asset-1",
        senderId: "admin-1",
      },
    },
  );

  assert.equal(
    cancelBookingTest.buildCancellationApprovalOwnerNotification({
      booking,
      ownerPenalty: null,
      ownerId: "owner-1",
      chatId: "chat-1",
      bookingId: "booking-1",
      assetId: "asset-1",
      senderId: "admin-1",
    }).body,
    "Camera for Apr 10, 2026 cancellation was approved.",
  );

  assert.doesNotMatch(
    cancelBookingTest.buildCancellationApprovalRenterNotification({
      booking,
      refundPlan: { amount: 1200, type: "full" },
      renterId: "renter-1",
      chatId: "chat-1",
      bookingId: "booking-1",
      assetId: "asset-1",
      senderId: "admin-1",
    }).body,
    /deducted|penalty|future payouts/i,
  );
});

test("new booking notification body includes listing and booking dates", () => {
  assert.equal(
    paymentBookingTest.formatNewBookingNotificationBody({
      assetTitle: "Camera",
      startDate: new Date(Date.UTC(2026, 3, 10)),
      endDate: new Date(Date.UTC(2026, 3, 12)),
    }),
    "Camera for Apr 10, 2026 was booked. Return date: Apr 12, 2026.",
  );
});

test("booking copy helpers format subject and purpose with safe fallbacks", () => {
  assert.equal(
    formatBookingSubject({
      asset: { title: "Camera" },
      startDate: { toDate: () => new Date(Date.UTC(2026, 3, 10)) },
    }),
    "Camera for Apr 10, 2026",
  );
  assert.equal(
    formatBookingPurpose({ asset: { title: "Camera" }, startDate: new Date(Date.UTC(2026, 3, 10)) }, "was returned."),
    "Camera for Apr 10, 2026 was returned.",
  );
  assert.equal(formatBookingSubject({}, "A booking"), "A booking");
});

test("cancellation refund plan rejects invalid partial refunds", () => {
  const booking = {
    paymentFlow: {
      amount: 1200,
      method: "card",
    },
  };

  assert.throws(
    () => cancelBookingTest.resolveCancellationRefundPlan({
      booking,
      refundAmount: 0,
      refundType: "partial",
    }),
    /Partial refund amount is required/,
  );
  assert.throws(
    () => cancelBookingTest.resolveCancellationRefundPlan({
      booking,
      refundAmount: 1300,
      refundType: "partial",
    }),
    /cannot exceed/,
  );
  assert.throws(
    () => cancelBookingTest.resolveCancellationRefundPlan({
      booking,
      refundAmount: null,
      refundType: "none",
    }),
    /only allowed for non-refundable/,
  );
  assert.throws(
    () => cancelBookingTest.resolveCancellationRefundPlan({
      booking: {
        cancellationRequest: {
          requestedByRole: "renter",
          renterPenaltyPreview: {
            tier: "no_refund",
            securityDepositRefundAmount: 250,
          },
        },
        paymentFlow: { amount: 1250, method: "card" },
        priceBreakdown: { rentalSubtotal: 1000, securityDepositAmount: 250 },
        securityDeposit: { enabled: true, amount: 250 },
      },
      refundAmount: null,
      refundType: "none",
    }),
    /security deposit is refundable/,
  );
});

test("cancellation refund plan skips QR PH and UBP Online Banking refunds", () => {
  assert.equal(
    cancelBookingTest.isNonRefundablePaymentMethod({
      paymentFlow: { method: "qrph" },
    }),
    true,
  );
  assert.equal(
    cancelBookingTest.isNonRefundablePaymentMethod({
      paymentFlow: { method: "dob", methodDetails: { bank_code: "ubp" } },
    }),
    true,
  );
  assert.equal(
    cancelBookingTest.isNonRefundablePaymentMethod({
      paymentFlow: { method: "dob", methodDetails: { bank_code: "bpi" } },
    }),
    false,
  );

  assert.deepEqual(
    cancelBookingTest.resolveCancellationRefundPlan({
      booking: { paymentFlow: { method: "qrph" } },
      refundAmount: null,
      refundType: "full",
    }),
    {
      amount: 0,
      reason: "QR PH and UBP Online Banking cannot be refunded.",
      status: "not_refundable",
      type: "none",
      retainedOwnerAmount: 0,
      manualSecurityDepositRefundAmount: 0,
      securityDepositRefundAmount: 0,
    },
  );

  assert.deepEqual(
    cancelBookingTest.resolveCancellationRefundPlan({
      booking: {
        cancellationRequest: { requestedByRole: "renter" },
        paymentFlow: { method: "qrph" },
        priceBreakdown: { rentalSubtotal: 3000, securityDepositAmount: 500 },
        securityDeposit: { enabled: true, amount: 500 },
      },
      refundAmount: null,
      refundType: "full",
    }),
    {
      amount: 0,
      reason: "QR PH and UBP Online Banking cannot be refunded.",
      status: "not_refundable",
      type: "none",
      retainedOwnerAmount: 3000,
      manualSecurityDepositRefundAmount: 500,
      securityDepositRefundAmount: 500,
    },
  );
});

test("review aggregate writes averageRating as a Firestore double for whole-number averages", () => {
  const write = submitBookingReviewTest.buildAssetRatingAggregateWrite(assetRef(), {
    averageRating: 5,
    reviewCount: 1,
  });

  assert.deepEqual(write.update.fields.averageRating, { doubleValue: 5 });
  assert.equal(write.update.fields.averageRating.integerValue, undefined);
  assert.deepEqual(write.update.fields.reviewCount, { integerValue: 1 });
  assert.deepEqual(write.updateMask.fieldPaths, ["averageRating", "reviewCount"]);
});

test("review aggregate writes averageRating as a Firestore double for fractional averages", () => {
  const write = submitBookingReviewTest.buildAssetRatingAggregateWrite(assetRef(), {
    averageRating: 4.5,
    reviewCount: 2,
  });

  assert.deepEqual(write.update.fields.averageRating, { doubleValue: 4.5 });
  assert.equal(write.update.fields.averageRating.integerValue, undefined);
  assert.deepEqual(write.update.fields.reviewCount, { integerValue: 2 });
});

function assetRef() {
  return {
    path: "assets/asset-1",
    formattedName: "projects/test-project/databases/(default)/documents/assets/asset-1",
  };
}
