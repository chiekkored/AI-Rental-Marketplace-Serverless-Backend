const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  buildSupportChatWrite,
  calculateRentalSubtotal,
  getSupportUserSnapshot,
  toAssetSnapshot,
  writeSupportChat,
  _test: {
    archiveExistingDisputeSupportChats,
    buildBookingPriceBreakdown,
    buildOutstandingDamagePriceBreakdown,
    buildDamageRequestSettlementPlan,
    deleteOutstandingDamagePaymentRequestMessage,
    buildDepositReturnProcessingNotificationRequest,
    buildDepositReturnProcessingNotice,
    buildFinalizedBookingSettlement,
    buildFinalOwnerPayoutBreakdown,
    buildRenterCancellationOwnerPayoutBreakdown,
    buildOwnerPenaltyDeduction,
    buildOwnerPayoutProcessingNotificationRequest,
    buildOwnerPayoutProcessingNotice,
    buildOutstandingDamagePaidBookingState,
    buildProviderPayoutInstitutionLists,
    getPayMongoEventId,
    getPayMongoEventType,
    getPayMongoPaymentIntentId,
    assertReturnedAwaitingOwnerAction,
    isClientCancellableCheckoutStatus,
    normalizeClientCancelReason,
    terminalRecoveryResult,
    applyOwnerPenaltyDeductionToBooking,
    writeCompletionRatingPrompt,
    writeDepositReturnProcessingMessage,
    writeOwnerCancellationPenaltyApplications,
    writeOwnerPayoutProcessingMessage,
    writeVisibleSystemMessage,
  },
} = require("../calls/payment/utils/paymentFlow.util");
const {
  PayMongoError,
  getPayMongoPublicKey,
  getPayMongoSecretKey,
  verifyWebhookSignature,
  _test: { buildPaymentIntentAttributes, buildSubscriptionAttributes, buildSubscriptionPlanAttributes, toPayMongoAmount },
} = require("../utils/paymongo.util");
const {
  buildRecurringBillingPlan,
  buildRentalBillingChunks,
  isRecurringPaymentMethodSupported,
  subtotalFromBillingChunks,
} = require("../calls/payment/recurringBilling");
const {
  _test: { buildAdminDisputeSupportChatUpdates },
} = require("../calls/payment/adminSendDisputeSupportMessage");
const {
  _test: {
    assertCanRequestOutstandingDamagePayment,
    buildOutstandingDamagePaymentState,
    buildOutstandingDamagePaymentMessageExtra,
    normalizeWholePositiveAmount,
    resolveRenterSupportChatId,
    writeOutstandingDamagePaymentSupportMessage,
  },
} = require("../calls/payment/adminRequestOutstandingDamagePayment");
const {
  DEFAULT_PRICING_POLICY,
  normalizePricingPolicyConfig,
} = require("../utils/remoteConfig.util")._test;

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

test("payment rental subtotal uses mixed monthly weekly and daily chunks", () => {
  const subtotal = calculateRentalSubtotal({
    rates: { daily: 500, weekly: 3000, monthly: 10000 },
    bookingRange: {
      startDate: new Date(2026, 5, 1),
      endDate: new Date(2026, 6, 11),
    },
  });

  assert.equal(subtotal, 14500);
});

test("PayMongo helpers read canonical keys in emulator mode", () => {
  withEnv(
    {
      FUNCTIONS_EMULATOR: "true",
      PAYMONGO_SECRET_KEY: " sk_test_canonical ",
      PAYMONGO_PUBLIC_KEY: " pk_test_canonical ",
      PAYMONGO_SECRET_KEY_TEST: "sk_test_legacy",
      PAYMONGO_PUBLIC_KEY_TEST: "pk_test_legacy",
    },
    () => {
      assert.equal(getPayMongoSecretKey(), "sk_test_canonical");
      assert.equal(getPayMongoPublicKey(), "pk_test_canonical");
    },
  );
});

test("PayMongo helpers read canonical keys in production mode", () => {
  withEnv(
    {
      FUNCTIONS_EMULATOR: "false",
      PAYMONGO_SECRET_KEY: " sk_live_canonical ",
      PAYMONGO_PUBLIC_KEY: " pk_live_canonical ",
    },
    () => {
      assert.equal(getPayMongoSecretKey(), "sk_live_canonical");
      assert.equal(getPayMongoPublicKey(), "pk_live_canonical");
    },
  );
});

test("PayMongo helpers require canonical keys", () => {
  withEnv(
    {
      FUNCTIONS_EMULATOR: "true",
      PAYMONGO_SECRET_KEY: undefined,
      PAYMONGO_PUBLIC_KEY: undefined,
      PAYMONGO_SECRET_KEY_TEST: "sk_test_legacy",
      PAYMONGO_PUBLIC_KEY_TEST: "pk_test_legacy",
    },
    () => {
      assert.throws(() => getPayMongoSecretKey(), PayMongoError);
      assert.throws(() => getPayMongoPublicKey(), PayMongoError);
    },
  );
});

test("PayMongo webhook verification reads canonical secret in emulator mode", () => {
  const rawBody = "{\"data\":{\"id\":\"evt_123\"}}";
  const timestamp = "1710000000";
  const secret = "whsec_canonical";
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

  withEnv(
    {
      FUNCTIONS_EMULATOR: "true",
      PAYMONGO_WEBHOOK_SECRET: secret,
      PAYMONGO_WEBHOOK_SECRET_TEST: "legacy_secret",
    },
    () => {
      assert.equal(
        verifyWebhookSignature({
          rawBody,
          headers: {
            "paymongo-signature": `t=${timestamp},te=${signature}`,
          },
        }),
        true,
      );
    },
  );
});

test("payment rental subtotal uses annual calendar-year chunks", () => {
  const subtotal = calculateRentalSubtotal({
    rates: { daily: 500, weekly: 3000, monthly: 10000, annually: 100000 },
    bookingRange: {
      startDate: new Date(2026, 5, 1),
      endDate: new Date(2027, 5, 1),
    },
  });

  assert.equal(subtotal, 100000);
});

test("recurring billing chunks use annual monthly weekly daily precedence", () => {
  const chunks = buildRentalBillingChunks({
    rates: { daily: 500, weekly: 3000, monthly: 10000, annually: 100000 },
    bookingRange: {
      startDate: new Date(2026, 5, 1),
      endDate: new Date(2027, 6, 9),
    },
  });

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ["annual", "monthly", "weekly", "daily"],
  );
  assert.equal(subtotalFromBillingChunks(chunks), 113500);
});

test("recurring billing plan collects short remaining cycles upfront", () => {
  const plan = buildRecurringBillingPlan({
    rates: { daily: 500, weekly: 3000, monthly: 10000 },
    bookingRange: {
      startDate: new Date(2026, 5, 1),
      endDate: new Date(2026, 6, 11),
    },
    priceBreakdown: {
      renterPlatformFee: 100,
      renterProcessingFee: 50,
      paymentAmount: 15150,
      currency: "PHP",
    },
    securityDeposit: { enabled: true, amount: 2000 },
  });

  assert.equal(plan.isRecurring, true);
  assert.equal(plan.recurringSubtotal, 13000);
  assert.equal(plan.scheduledRecurringAmount, 0);
  assert.equal(plan.upfront.rentalDailyRemainderAmount, 1500);
  assert.equal(plan.upfront.firstRecurringAmount, 13000);
  assert.equal(plan.upfront.rentalAmountDueNow, 14500);
  assert.equal(plan.upfront.securityDepositAmount, 2000);
  assert.equal(plan.subscriptionSchedules.length, 0);
  assert.equal(plan.chunks.filter((chunk) => chunk.billingMode === "subscription").length, 0);
  assert.equal(plan.chunks[0].billingMode, "upfront");
  assert.equal(plan.chunks[0].status, "included_upfront");
  assert.equal(plan.chunks[1].billingMode, "upfront");
  assert.equal(plan.chunks[2].billingMode, "upfront");
});

test("recurring billing plan creates one subscription for the largest cadence only", () => {
  const plan = buildRecurringBillingPlan({
    rates: { daily: 100, weekly: 700, monthly: 3000 },
    bookingRange: {
      startDate: new Date(2026, 0, 1),
      endDate: new Date(2026, 5, 23),
    },
    priceBreakdown: {
      renterPlatformFee: 0,
      renterProcessingFee: 0,
      paymentAmount: 4500,
      currency: "PHP",
    },
    securityDeposit: { enabled: true, amount: 500 },
  });

  assert.equal(plan.isRecurring, true);
  assert.equal(plan.upfront.rentalDailyRemainderAmount, 100);
  assert.equal(plan.upfront.firstRecurringAmount, 5100);
  assert.equal(plan.upfront.rentalAmountDueNow, 5200);
  assert.equal(plan.scheduledRecurringAmount, 12000);
  assert.equal(plan.subscriptionSchedules.length, 1);
  assert.deepEqual(
    {
      amount: plan.subscriptionSchedules[0].amount,
      interval: plan.subscriptionSchedules[0].interval,
      cycleCount: plan.subscriptionSchedules[0].cycleCount,
      anchorDate: plan.subscriptionSchedules[0].anchorDate,
    },
    {
      amount: 3000,
      interval: "monthly",
      cycleCount: 4,
      anchorDate: "2026-02-01",
    },
  );
  assert.equal(plan.chunks.filter((chunk) => chunk.billingMode === "subscription").length, 4);
  assert.equal(plan.chunks.filter((chunk) => chunk.type === "weekly" && chunk.billingMode === "upfront").length, 3);
});

test("recurring billing plan uses weekly subscription when there is no larger cadence", () => {
  const plan = buildRecurringBillingPlan({
    rates: { daily: 100, weekly: 700 },
    bookingRange: {
      startDate: new Date(2026, 0, 1),
      endDate: new Date(2026, 0, 23),
    },
    priceBreakdown: {
      renterPlatformFee: 0,
      renterProcessingFee: 0,
      paymentAmount: 800,
      currency: "PHP",
    },
    securityDeposit: { enabled: false, amount: 0 },
  });

  assert.equal(plan.upfront.rentalDailyRemainderAmount, 100);
  assert.equal(plan.upfront.firstRecurringAmount, 700);
  assert.equal(plan.upfront.rentalAmountDueNow, 800);
  assert.equal(plan.scheduledRecurringAmount, 1400);
  assert.equal(plan.subscriptionSchedules.length, 1);
  assert.deepEqual(
    {
      amount: plan.subscriptionSchedules[0].amount,
      interval: plan.subscriptionSchedules[0].interval,
      cycleCount: plan.subscriptionSchedules[0].cycleCount,
      anchorDate: plan.subscriptionSchedules[0].anchorDate,
    },
    {
      amount: 700,
      interval: "weekly",
      cycleCount: 2,
      anchorDate: "2026-01-08",
    },
  );
});

test("recurring billing plan collects weekly rentals upfront when remaining cycles are too short", () => {
  const plan = buildRecurringBillingPlan({
    rates: { daily: 100, weekly: 700 },
    bookingRange: {
      startDate: new Date(2026, 0, 1),
      endDate: new Date(2026, 0, 16),
    },
    priceBreakdown: {
      renterPlatformFee: 0,
      renterProcessingFee: 0,
      paymentAmount: 1500,
      currency: "PHP",
    },
    securityDeposit: { enabled: false, amount: 0 },
  });

  assert.equal(plan.upfront.rentalDailyRemainderAmount, 100);
  assert.equal(plan.upfront.firstRecurringAmount, 1400);
  assert.equal(plan.upfront.rentalAmountDueNow, 1500);
  assert.equal(plan.scheduledRecurringAmount, 0);
  assert.equal(plan.subscriptionSchedules.length, 0);
});

test("booking pricing charges only due-now rental subtotal for recurring checkout", () => {
  const policy = normalizePricingPolicyConfig(DEFAULT_PRICING_POLICY);
  const pricing = buildBookingPriceBreakdown({
    rentalSubtotal: 16500,
    chargeableRentalSubtotal: 3100,
    securityDeposit: { enabled: true, amount: 500 },
    policy,
    selectedPaymentMethod: "card",
    selectedPaymentMethodDetails: { card_brand: "visa" },
    currency: "PHP",
  });

  assert.equal(pricing.rentalSubtotal, 16500);
  assert.equal(pricing.dueNowRentalSubtotal, 3100);
  assert.equal(pricing.scheduledRentalSubtotal, 13400);
  assert.equal(pricing.securityDepositAmount, 500);
  assert.equal(pricing.paymentAmount < 17000, true);
  assert.equal(pricing.paymongoPaymentAmount, pricing.paymentAmount * 100);
});

test("recurring billing payment method support defers method eligibility to app config", () => {
  assert.equal(
    isRecurringPaymentMethodSupported({
      paymentMethod: "card",
      paymentMethodDetails: { card_brand: "Visa" },
    }),
    true,
  );
  assert.equal(
    isRecurringPaymentMethodSupported({
      paymentMethod: "card",
      paymentMethodDetails: { card_brand: "Mastercard" },
    }),
    true,
  );
  assert.equal(isRecurringPaymentMethodSupported({ paymentMethod: "paymaya" }), true);
  assert.equal(
    isRecurringPaymentMethodSupported({
      paymentMethod: "card",
      paymentMethodDetails: { card_brand: "Amex" },
    }),
    true,
  );
  assert.equal(isRecurringPaymentMethodSupported({ paymentMethod: "gcash" }), true);
  assert.equal(isRecurringPaymentMethodSupported({ paymentMethod: "" }), false);
});

test("payment booking asset snapshot includes the complete asset", () => {
  const snapshot = toAssetSnapshot(
    {
      ownerId: "owner-1",
      owner: { uid: "owner-1" },
      title: "Camera",
      description: "A camera available for events.",
      images: ["image-1"],
      showcase: ["showcase-1"],
      inclusions: ["Battery"],
      categoryId: "cameras", categoryName: "Cameras",
      listingKind: "item",
      detailSchemaKey: "camera",
      details: { brand: "Canon" },
      rates: { daily: 1000 },
      createdAt: "created-at",
      status: "Available",
      location: { description: "Makati" },
      averageRating: 4.8,
      reviewCount: 5,
      securityDeposit: { enabled: true, amount: 5000 },
      ownerInstructions: "Bring a valid ID.",
      blocksEndDate: true,
    },
    "asset-1",
  );

  assert.equal(snapshot.id, "asset-1");
  assert.equal(snapshot.description, "A camera available for events.");
  assert.deepEqual(snapshot.showcase, ["showcase-1"]);
  assert.deepEqual(snapshot.inclusions, ["Battery"]);
  assert.deepEqual(snapshot.details, { brand: "Canon" });
  assert.equal(snapshot.averageRating, 4.8);
  assert.equal(snapshot.reviewCount, 5);
  assert.equal(snapshot.ownerInstructions, "Bring a valid ID.");
  assert.equal(snapshot.blocksEndDate, true);
});

test("payment booking asset snapshot defaults missing owner instructions", () => {
  const snapshot = toAssetSnapshot(
    {
      owner: { uid: "owner-1" },
      title: "Camera",
      securityDeposit: { enabled: false, amount: 0 },
    },
    "asset-1",
  );

  assert.equal(snapshot.ownerInstructions, null);
  assert.equal(snapshot.blocksEndDate, false);
});

test("outstanding damage pricing applies international card fee for non-PH renter country", () => {
  const policy = normalizePricingPolicyConfig(DEFAULT_PRICING_POLICY);
  const pricing = buildOutstandingDamagePriceBreakdown({
    amount: 10000,
    policy,
    selectedPaymentMethod: "card",
    selectedPaymentMethodDetails: {},
    payerCountryShortName: "SG",
    currency: "PHP",
  });

  assert.equal(pricing.paymentMethod.source, "card.international");
  assert.equal(pricing.renterProcessingFee, 465.24);
  assert.equal(pricing.paymentAmount, 10465.24);
});

class FakeDocRef {
  constructor(path) {
    this.path = path;
    this.id = path.split("/").at(-1);
  }

  collection(name) {
    return new FakeCollectionRef(`${this.path}/${name}`);
  }
}

class FakeCollectionRef {
  constructor(path) {
    this.path = path;
    this.nextId = 1;
  }

  doc(id) {
    const docId = id || `${this.path.replaceAll("/", "_")}_${this.nextId++}`;
    return new FakeDocRef(`${this.path}/${docId}`);
  }
}

function fakeDb() {
  return {
    collection(name) {
      return new FakeCollectionRef(name);
    },
  };
}

function fakeSupportBooking() {
  return {
    id: "booking-1",
    chatId: "chat-1",
    status: "Returned",
    startDate: "2026-01-01",
    endDate: "2026-01-02",
    renter: {
      uid: "renter-1",
      firstName: "Rina",
      lastName: "Renter",
    },
    asset: {
      id: "asset-1",
      title: "Camera",
      owner: {
        uid: "owner-1",
        firstName: "Owen",
        lastName: "Owner",
      },
    },
  };
}

function fakeArchiveBooking(disputeFlow = {}) {
  return {
    ...fakeSupportBooking(),
    disputeFlow,
  };
}

function fakeTx(existingPaths = []) {
  const existing = new Set(existingPaths);
  const writes = [];
  const deletes = [];
  return {
    deletes,
    writes,
    async get(ref) {
      return { exists: existing.has(ref.path) };
    },
    set(ref, payload, options) {
      writes.push({ path: ref.path, payload, options });
    },
    delete(ref) {
      deletes.push({ path: ref.path });
    },
  };
}

function withSupportUserId(value, fn) {
  const previous = process.env.LEND_SUPPORT_USER_ID;
  if (value == null) {
    delete process.env.LEND_SUPPORT_USER_ID;
  } else {
    process.env.LEND_SUPPORT_USER_ID = value;
  }
  try {
    fn();
  } finally {
    if (previous == null) {
      delete process.env.LEND_SUPPORT_USER_ID;
    } else {
      process.env.LEND_SUPPORT_USER_ID = previous;
    }
  }
}

test("payment support user defaults to canonical mobile support uid", () => {
  withSupportUserId(null, () => {
    assert.equal(getSupportUserSnapshot().uid, "lend_support");
  });
});

test("admin dispute support messages mark sender mirror read and participant mirror unread", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const updates = buildAdminDisputeSupportChatUpdates({
    text: "We are reviewing this dispute.",
    now,
    supportUserId: "lend_support",
  });

  assert.deepEqual(updates.rootChatUpdate, {
    lastMessage: "We are reviewing this dispute.",
    lastMessageDate: now,
    lastMessageSenderId: "lend_support",
    hasRead: false,
  });
  assert.deepEqual(updates.participantChatUpdate, {
    lastMessage: "We are reviewing this dispute.",
    lastMessageDate: now,
    lastMessageSenderId: "lend_support",
    hasRead: false,
  });
  assert.deepEqual(updates.supportChatUpdate, {
    lastMessage: "We are reviewing this dispute.",
    lastMessageDate: now,
    lastMessageSenderId: "lend_support",
    hasRead: true,
  });
});

test("renter dispute support chat mirrors only to renter and lend support", () => {
  withSupportUserId(null, () => {
    const supportChat = buildSupportChatWrite({
      db: fakeDb(),
      booking: fakeSupportBooking(),
      target: "renter",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    const writes = [];
    const tx = {
      set(ref, payload, options) {
        writes.push({ path: ref.path, payload, options });
      },
    };

    writeSupportChat(tx, supportChat);

    assert.equal(supportChat.participantUserId, "renter-1");
    assert.deepEqual(
      writes
        .map((write) => write.path)
        .filter((path) => path.startsWith("userChats/"))
        .sort(),
      [
        "userChats/lend_support",
        `userChats/lend_support/chats/${supportChat.chatRef.id}`,
        "userChats/renter-1",
        `userChats/renter-1/chats/${supportChat.chatRef.id}`,
      ].sort(),
    );
    assert.equal(
      writes.some((write) => write.path.startsWith("userChats/owner-1/")),
      false,
    );
  });
});

test("outstanding damage payment request uses renter support chat mirrors only", () => {
  withSupportUserId(null, () => {
    const tx = fakeTx();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const booking = {
      ...fakeSupportBooking(),
      disputeFlow: { renterSupportChatId: "renter-support-chat" },
    };

    writeOutstandingDamagePaymentSupportMessage(tx, {
      db: fakeDb(),
      booking,
      chatId: "renter-support-chat",
      renterId: "renter-1",
      paymentRequestId: "damage-payment-request-1",
      amount: 250,
      currency: "PHP",
      now,
    });

    const writesByPath = new Map(tx.writes.map((write) => [write.path, write]));
    const messageWrite = writesByPath.get(
      "chats/renter-support-chat/messages/booking-outstanding-damage-payment-request-booking-1",
    );

    assert.deepEqual(
      tx.writes.map((write) => write.path).sort(),
      [
        "chats/renter-support-chat",
        "chats/renter-support-chat/messages/booking-outstanding-damage-payment-request-booking-1",
        "userChats/lend_support/chats/renter-support-chat",
        "userChats/renter-1/chats/renter-support-chat",
      ].sort(),
    );
    assert.equal(
      tx.writes.some((write) => write.path.startsWith("userChats/owner-1/")),
      false,
    );
    assert.deepEqual(messageWrite.payload, {
      id: "booking-outstanding-damage-payment-request-booking-1",
      text: "Outstanding damage payment requested: PHP 250.",
      senderId: "lend_support",
      createdAt: now,
      type: "system",
      systemAction: "damage_balance_payment_request",
      damagePaymentRequestId: "damage-payment-request-1",
      paymentRequestId: "damage-payment-request-1",
      paymentStatus: "pending",
      amount: 250,
      currency: "PHP",
      visibleTo: ["renter-1", "lend_support"],
    });
    assert.equal(writesByPath.get("chats/renter-support-chat").payload.lastMessageSenderId, "lend_support");
    assert.equal(writesByPath.get("userChats/renter-1/chats/renter-support-chat").payload.chatType, "lend_support");
  });
});

test("outstanding damage payment request requires matching renter support chat", () => {
  const booking = {
    ...fakeSupportBooking(),
    disputeFlow: { renterSupportChatId: "renter-support-chat" },
  };

  assert.equal(resolveRenterSupportChatId(booking, "renter-support-chat"), "renter-support-chat");
  assert.equal(resolveRenterSupportChatId(booking, null), "renter-support-chat");
  assert.throws(() => resolveRenterSupportChatId(booking, "owner-support-chat"), /Support chat does not match/);
  assert.throws(() => resolveRenterSupportChatId(fakeSupportBooking(), null), /Renter support chat is required/);
});

test("paid outstanding damage cleanup deletes pending payment request message", () => {
  const tx = fakeTx();

  deleteOutstandingDamagePaymentRequestMessage(tx, {
    db: fakeDb(),
    chatId: "renter-support-chat",
    bookingId: "booking-1",
  });

  assert.deepEqual(tx.deletes, [
    {
      path: "chats/renter-support-chat/messages/booking-outstanding-damage-payment-request-booking-1",
    },
  ]);
});

test("dispute support chat rejects support uid configured as a booking participant", () => {
  withSupportUserId("owner-1", () => {
    assert.throws(
      () =>
        buildSupportChatWrite({
          db: fakeDb(),
          booking: fakeSupportBooking(),
          target: "renter",
          now: new Date("2026-01-01T00:00:00.000Z"),
        }),
      /Lend Support user cannot be a booking participant/,
    );
  });
});

test("settlement archive skips support chat writes when no support chats exist", async () => {
  const tx = fakeTx();

  await archiveExistingDisputeSupportChats({
    db: fakeDb(),
    tx,
    booking: fakeArchiveBooking(),
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.deepEqual(tx.writes, []);
});

test("settlement archive closes renter and owner support chats without cross-writing user inboxes", async () => {
  const tx = fakeTx([
    "chats/renter-support-chat",
    "userChats/renter-1/chats/renter-support-chat",
    "userChats/lend_support/chats/renter-support-chat",
    "chats/owner-support-chat",
    "userChats/owner-1/chats/owner-support-chat",
    "userChats/lend_support/chats/owner-support-chat",
  ]);
  const now = new Date("2026-01-01T00:00:00.000Z");

  await archiveExistingDisputeSupportChats({
    db: fakeDb(),
    tx,
    booking: fakeArchiveBooking({
      renterSupportChatId: "renter-support-chat",
      ownerSupportChatId: "owner-support-chat",
    }),
    now,
  });

  assert.deepEqual(
    tx.writes.map((write) => write.path).sort(),
    [
      "chats/owner-support-chat",
      "chats/renter-support-chat",
      "userChats/lend_support/chats/owner-support-chat",
      "userChats/lend_support/chats/renter-support-chat",
      "userChats/owner-1/chats/owner-support-chat",
      "userChats/renter-1/chats/renter-support-chat",
    ].sort(),
  );
  assert.equal(
    tx.writes.some((write) => write.path === "userChats/owner-1/chats/renter-support-chat"),
    false,
  );
  assert.equal(
    tx.writes.some((write) => write.path === "userChats/renter-1/chats/owner-support-chat"),
    false,
  );
  assert.deepEqual(tx.writes[0].payload, {
    status: "Archived",
    updatedAt: now,
    lastUpdated: now,
  });
  assert.deepEqual(tx.writes[0].options, { merge: true });
});

test("settlement archive does not create missing support chat documents", async () => {
  const tx = fakeTx([
    "chats/renter-support-chat",
    "userChats/renter-1/chats/renter-support-chat",
  ]);

  await archiveExistingDisputeSupportChats({
    db: fakeDb(),
    tx,
    booking: fakeArchiveBooking({
      renterSupportChatId: "renter-support-chat",
    }),
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.deepEqual(
    tx.writes.map((write) => write.path).sort(),
    [
      "chats/renter-support-chat",
      "userChats/renter-1/chats/renter-support-chat",
    ].sort(),
  );
});

test("completion rating prompt keeps renter chat active and archives owner chat", () => {
  const tx = fakeTx();
  const now = new Date("2026-01-01T00:00:00.000Z");

  writeCompletionRatingPrompt(tx, {
    db: fakeDb(),
    booking: { ...fakeSupportBooking(), status: "Completed" },
    now,
  });

  const writesByPath = new Map(tx.writes.map((write) => [write.path, write]));
  const messageWrite = writesByPath.get("chats/chat-1/messages/booking-rating-request-booking-1");
  const rootChatWrite = writesByPath.get("chats/chat-1");
  const renterChatWrite = writesByPath.get("userChats/renter-1/chats/chat-1");
  const ownerChatWrite = writesByPath.get("userChats/owner-1/chats/chat-1");

  assert.deepEqual(messageWrite.payload, {
    id: "booking-rating-request-booking-1",
    text: "Booking completed. Rate your rental experience.",
    senderId: "",
    createdAt: now,
    type: "rating",
    systemAction: "rating-request",
    bookingId: "booking-1",
    chatId: "chat-1",
    visibleTo: ["renter-1"],
  });
  assert.equal(rootChatWrite.payload.status, "Active");
  assert.equal(rootChatWrite.payload.lastMessage, "Booking completed.");
  assert.equal(renterChatWrite.payload.status, "Active");
  assert.equal(ownerChatWrite.payload.status, "Archived");
  assert.equal(renterChatWrite.payload.bookingStatus, "Completed");
  assert.equal(ownerChatWrite.payload.bookingStatus, "Completed");
  assert.equal(renterChatWrite.payload.lastMessage, "Booking completed. Rate your rental experience.");
  assert.equal(Object.hasOwn(ownerChatWrite.payload, "lastMessage"), false);
  assert.equal(Object.hasOwn(ownerChatWrite.payload, "lastMessageDate"), false);
  assert.equal(Object.hasOwn(ownerChatWrite.payload, "lastMessageSenderId"), false);
  assert.equal(tx.writes.length, 4);
});

test("visible system message updates only included user chat previews", () => {
  const tx = fakeTx();
  const now = new Date("2026-01-01T00:00:00.000Z");

  writeVisibleSystemMessage(tx, {
    db: fakeDb(),
    booking: { ...fakeSupportBooking(), status: "Returned" },
    messageText: "Renter-only payment reminder.",
    messageName: "renter-payment-reminder",
    visibleTo: ["renter-1"],
    now,
  });

  const writesByPath = new Map(tx.writes.map((write) => [write.path, write]));
  const messageWrite = writesByPath.get("chats/chat-1/messages/booking-renter-payment-reminder-booking-1");
  const rootChatWrite = writesByPath.get("chats/chat-1");
  const renterChatWrite = writesByPath.get("userChats/renter-1/chats/chat-1");
  const ownerChatWrite = writesByPath.get("userChats/owner-1/chats/chat-1");

  assert.deepEqual(messageWrite.payload.visibleTo, ["renter-1"]);
  assert.equal(rootChatWrite.payload.lastMessage, "New booking update.");
  assert.equal(renterChatWrite.payload.lastMessage, "Renter-only payment reminder.");
  assert.equal(Object.hasOwn(ownerChatWrite.payload, "lastMessage"), false);
  assert.equal(Object.hasOwn(ownerChatWrite.payload, "lastMessageDate"), false);
  assert.equal(Object.hasOwn(ownerChatWrite.payload, "lastMessageSenderId"), false);
});

test("visible system message keeps unrestricted previews unchanged", () => {
  const tx = fakeTx();
  const now = new Date("2026-01-01T00:00:00.000Z");

  writeVisibleSystemMessage(tx, {
    db: fakeDb(),
    booking: { ...fakeSupportBooking(), status: "Returned" },
    messageText: "Damage request submitted.",
    messageName: "damage-request-submitted",
    now,
  });

  const writesByPath = new Map(tx.writes.map((write) => [write.path, write]));

  assert.equal(writesByPath.get("chats/chat-1").payload.lastMessage, "Damage request submitted.");
  assert.equal(writesByPath.get("userChats/renter-1/chats/chat-1").payload.lastMessage, "Damage request submitted.");
  assert.equal(writesByPath.get("userChats/owner-1/chats/chat-1").payload.lastMessage, "Damage request submitted.");
});

test("visible system message can update excluded user status without leaking preview", () => {
  const tx = fakeTx();
  const now = new Date("2026-01-01T00:00:00.000Z");

  writeVisibleSystemMessage(tx, {
    db: fakeDb(),
    booking: { ...fakeSupportBooking(), status: "Completed" },
    messageText: "Renter-only rating prompt.",
    messageName: "renter-rating-prompt",
    visibleTo: ["renter-1"],
    chatStatusByUser: { "owner-1": "Archived" },
    now,
  });

  const ownerChatWrite = tx.writes.find((write) => write.path === "userChats/owner-1/chats/chat-1");

  assert.equal(ownerChatWrite.payload.status, "Archived");
  assert.equal(ownerChatWrite.payload.bookingStatus, "Completed");
  assert.equal(Object.hasOwn(ownerChatWrite.payload, "lastMessage"), false);
});

test("completion rating prompt no-ops without a renter or chat", () => {
  const tx = fakeTx();
  const booking = fakeSupportBooking();

  writeCompletionRatingPrompt(tx, {
    db: fakeDb(),
    booking: { ...booking, chatId: null },
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  writeCompletionRatingPrompt(tx, {
    db: fakeDb(),
    booking: { ...booking, renter: null },
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.deepEqual(tx.writes, []);
});

test("deposit return processing message is renter-only and includes amount timeline", () => {
  const tx = fakeTx();
  const now = new Date("2026-01-01T00:00:00.000Z");

  writeDepositReturnProcessingMessage(tx, {
    db: fakeDb(),
    booking: {
      ...fakeSupportBooking(),
      status: "Completed",
      paymentFlow: { currency: "PHP" },
      depositFlow: { required: true, amount: 500 },
    },
    depositReturnAmount: 500,
    now,
  });

  const writesByPath = new Map(tx.writes.map((write) => [write.path, write]));
  const messageWrite = writesByPath.get("chats/chat-1/messages/booking-deposit_return_processing-booking-1");
  const rootChatWrite = writesByPath.get("chats/chat-1");
  const renterChatWrite = writesByPath.get("userChats/renter-1/chats/chat-1");
  const ownerChatWrite = writesByPath.get("userChats/owner-1/chats/chat-1");
  const expectedText =
    "Your security deposit return of PHP 500 is being processed. Expect it on or before 7 business days.";

  assert.equal(messageWrite.payload.text, expectedText);
  assert.equal(messageWrite.payload.type, "system");
  assert.equal(messageWrite.payload.systemAction, "deposit_return_processing");
  assert.deepEqual(messageWrite.payload.visibleTo, ["renter-1"]);
  assert.equal(messageWrite.payload.amount, 500);
  assert.equal(messageWrite.payload.currency, "PHP");
  assert.equal(rootChatWrite.payload.lastMessage, "New booking update.");
  assert.equal(renterChatWrite.payload.lastMessage, expectedText);
  assert.equal(Object.hasOwn(ownerChatWrite.payload, "lastMessage"), false);
});

test("deposit return processing notification is persisted-only for renter", () => {
  const notification = buildDepositReturnProcessingNotificationRequest({
    booking: {
      ...fakeSupportBooking(),
      paymentFlow: { currency: "PHP" },
      depositFlow: { required: true, amount: 500 },
    },
    depositReturnAmount: 500,
  });

  assert.deepEqual(notification, {
    uid: "renter-1",
    title: "Security deposit return processing",
    body: "Your security deposit return of PHP 500 is being processed. Expect it on or before 7 business days.",
    push: false,
    data: {
      type: "deposit_return_processing",
      bookingId: "booking-1",
      chatId: "chat-1",
      assetId: "asset-1",
      imageUrl: null,
      amount: 500,
      currency: "PHP",
    },
  });
});

test("deposit return processing notice no-ops without deposit return", () => {
  const booking = {
    ...fakeSupportBooking(),
    depositFlow: { required: true, amount: 500 },
  };

  assert.equal(buildDepositReturnProcessingNotice({ booking, depositReturnAmount: 0 }), null);
  assert.equal(
    buildDepositReturnProcessingNotice({
      booking: { ...fakeSupportBooking(), depositFlow: { required: false, amount: 0 } },
      depositReturnAmount: 500,
    }),
    null,
  );
});

test("owner payout processing message is owner-only and includes amount", () => {
  const tx = fakeTx();
  const now = new Date("2026-01-01T00:00:00.000Z");
  const booking = {
    ...fakeSupportBooking(),
    status: "Completed",
    paymentFlow: { currency: "PHP" },
  };
  const notice = buildOwnerPayoutProcessingNotice({
    booking,
    movementType: "owner_payout",
    amount: 90,
    currency: "PHP",
  });

  writeOwnerPayoutProcessingMessage(tx, {
    db: fakeDb(),
    booking,
    notice,
    now,
  });

  const writesByPath = new Map(tx.writes.map((write) => [write.path, write]));
  const messageWrite = writesByPath.get("chats/chat-1/messages/booking-owner_payout_processing_owner_payout-booking-1");
  const rootChatWrite = writesByPath.get("chats/chat-1");
  const renterChatWrite = writesByPath.get("userChats/renter-1/chats/chat-1");
  const ownerChatWrite = writesByPath.get("userChats/owner-1/chats/chat-1");
  const expectedText =
    "Your owner payout of PHP 90 is being processed. You will receive it in your account on or before 7 business days.";

  assert.equal(messageWrite.payload.text, expectedText);
  assert.equal(messageWrite.payload.type, "system");
  assert.equal(messageWrite.payload.systemAction, "owner_payout_processing");
  assert.deepEqual(messageWrite.payload.visibleTo, ["owner-1"]);
  assert.equal(messageWrite.payload.amount, 90);
  assert.equal(messageWrite.payload.currency, "PHP");
  assert.equal(messageWrite.payload.movementType, "owner_payout");
  assert.equal(rootChatWrite.payload.lastMessage, "New booking update.");
  assert.equal(ownerChatWrite.payload.lastMessage, expectedText);
  assert.equal(Object.hasOwn(renterChatWrite.payload, "lastMessage"), false);
});

test("owner payout processing notification is persisted-only for owner", () => {
  const notice = buildOwnerPayoutProcessingNotice({
    booking: { ...fakeSupportBooking(), paymentFlow: { currency: "PHP" } },
    movementType: "renter_cancellation_owner_payout",
    amount: 500,
    currency: "PHP",
  });

  assert.deepEqual(buildOwnerPayoutProcessingNotificationRequest({ notice }), {
    uid: "owner-1",
    title: "Owner payout processing",
    body: "Your owner payout of PHP 500 is being processed. You will receive it in your account on or before 7 business days.",
    push: false,
    data: {
      type: "owner_payout_processing",
      bookingId: "booking-1",
      chatId: "chat-1",
      assetId: "asset-1",
      imageUrl: null,
      amount: 500,
      currency: "PHP",
      movementType: "renter_cancellation_owner_payout",
    },
  });
});

test("owner payout processing notice no-ops for non-owner payouts and invalid context", () => {
  const booking = { ...fakeSupportBooking(), paymentFlow: { currency: "PHP" } };

  assert.equal(
    buildOwnerPayoutProcessingNotice({
      booking,
      movementType: "deposit_return",
      amount: 500,
      currency: "PHP",
    }),
    null,
  );
  assert.equal(
    buildOwnerPayoutProcessingNotice({
      booking,
      movementType: "owner_payout",
      amount: 0,
      currency: "PHP",
    }),
    null,
  );
  assert.equal(
    buildOwnerPayoutProcessingNotice({
      booking: { ...booking, chatId: null },
      movementType: "owner_payout",
      amount: 90,
      currency: "PHP",
    }),
    null,
  );
});

test("returned booking settlement allows no-deposit bookings with deposit status none", () => {
  assert.doesNotThrow(() =>
    assertReturnedAwaitingOwnerAction({
      status: "Returned",
      securityDeposit: { enabled: false, amount: 0 },
      depositFlow: { required: false, amount: 0, status: "none" },
    }),
  );
});

test("returned booking settlement rejects deposit-backed bookings with deposit status none", () => {
  assert.throws(
    () =>
      assertReturnedAwaitingOwnerAction({
        status: "Returned",
        securityDeposit: { enabled: true, amount: 500 },
        depositFlow: { required: true, amount: 500, status: "none" },
      }),
    /Booking is not awaiting owner settlement action/,
  );
});

test("damage request plan sends no-deposit support reasons to support review", () => {
  const plan = buildDamageRequestSettlementPlan({
    depositAmount: 0,
    requestedAmount: null,
    reason: "Total loss/damage",
  });

  assert.equal(plan.amount, null);
  assert.equal(plan.depositAmount, 0);
  assert.equal(plan.depositCoveredAmount, 0);
  assert.equal(plan.outstandingAmount, 0);
  assert.equal(plan.needsSupport, true);
});

test("damage request plan sends deposit-backed support reasons to support review without fake amount", () => {
  const plan = buildDamageRequestSettlementPlan({
    depositAmount: 500,
    requestedAmount: null,
    reason: "Higher than security deposit",
  });

  assert.equal(plan.amount, null);
  assert.equal(plan.depositAmount, 500);
  assert.equal(plan.depositCoveredAmount, 0);
  assert.equal(plan.outstandingAmount, 0);
  assert.equal(plan.needsSupport, true);
});

test("damage request plan rejects no-deposit non-support reasons", () => {
  assert.throws(
    () =>
      buildDamageRequestSettlementPlan({
        depositAmount: 0,
        requestedAmount: 100,
        reason: "Damage",
      }),
    /Damage fees without a security deposit require Lend Support review/,
  );
});

test("damage request plan keeps deposit-backed in renter response when covered by deposit", () => {
  const plan = buildDamageRequestSettlementPlan({
    depositAmount: 500,
    requestedAmount: 300,
    reason: "Damage",
  });

  assert.equal(plan.amount, 300);
  assert.equal(plan.depositAmount, 500);
  assert.equal(plan.depositCoveredAmount, 300);
  assert.equal(plan.outstandingAmount, 0);
  assert.equal(plan.needsSupport, false);
});

test("final owner payout uses rental gross instead of checkout owner net", () => {
  const payout = buildFinalOwnerPayoutBreakdown({
    booking: {
      totalPrice: 100,
      priceBreakdown: {
        rentalSubtotal: 100,
        ownerPayoutAmount: 90,
        ownerPayoutTransferFee: 10,
        transferFeeRule: { rateBps: 0, fixedAmount: 10, calculation: "fixed_only" },
      },
    },
    depositCoveredAmount: 0,
    paidOutstandingAmount: 0,
    depositReturnAmount: 0,
  });

  assert.equal(payout.ownerPayoutGrossAmount, 100);
  assert.equal(payout.ownerPayoutTransferFee, 10);
  assert.equal(payout.securityDepositCollectionProcessingFee, 0);
  assert.equal(payout.renterDepositReturnTransferFee, 0);
  assert.equal(payout.ownerProcessingFee, 10);
  assert.equal(payout.ownerPayoutAmount, 90);
});

test("renter cancellation owner payout deducts wallet transfer fee", () => {
  const payout = buildRenterCancellationOwnerPayoutBreakdown({
    booking: {
      priceBreakdown: {
        transferFeeRule: {
          rateBps: 0,
          fixedAmount: 10,
          calculation: "fixed_only",
        },
      },
    },
    retainedOwnerAmount: 100,
  });

  assert.equal(payout.ownerPayoutGrossAmount, 100);
  assert.equal(payout.ownerPayoutTransferFee, 10);
  assert.equal(payout.ownerPayoutAmount, 90);
});

test("renter cancellation owner payout floors net payout at zero", () => {
  const payout = buildRenterCancellationOwnerPayoutBreakdown({
    booking: {
      priceBreakdown: {
        transferFeeRule: {
          rateBps: 0,
          fixedAmount: 10,
          calculation: "fixed_only",
        },
      },
    },
    retainedOwnerAmount: 8,
  });

  assert.equal(payout.ownerPayoutGrossAmount, 8);
  assert.equal(payout.ownerPayoutTransferFee, 10);
  assert.equal(payout.ownerPayoutAmount, 0);
});

test("final owner payout adds approved damage before one transfer fee", () => {
  const payout = buildFinalOwnerPayoutBreakdown({
    booking: {
      totalPrice: 100,
      priceBreakdown: {
        rentalSubtotal: 100,
        ownerPayoutAmount: 90,
        ownerPayoutTransferFee: 10,
        transferFeeRule: { rateBps: 0, fixedAmount: 10, calculation: "fixed_only" },
      },
    },
    depositCoveredAmount: 25,
    paidOutstandingAmount: 50,
    depositReturnAmount: 0,
  });

  assert.equal(payout.ownerPayoutGrossAmount, 175);
  assert.equal(payout.ownerPayoutTransferFee, 10);
  assert.equal(payout.securityDepositCollectionProcessingFee, 0);
  assert.equal(payout.renterDepositReturnTransferFee, 0);
  assert.equal(payout.ownerProcessingFee, 10);
  assert.equal(payout.ownerPayoutAmount, 165);
});

test("final owner payout legacy fallback restores gross from net plus transfer fee", () => {
  const payout = buildFinalOwnerPayoutBreakdown({
    booking: {
      priceBreakdown: {
        ownerPayoutAmount: 90,
        ownerPayoutTransferFee: 10,
        transferFeeRule: { rateBps: 0, fixedAmount: 10, calculation: "fixed_only" },
      },
    },
    depositCoveredAmount: 0,
    paidOutstandingAmount: 0,
    depositReturnAmount: 0,
  });

  assert.equal(payout.ownerPayoutGrossAmount, 100);
  assert.equal(payout.ownerPayoutTransferFee, 10);
  assert.equal(payout.securityDepositCollectionProcessingFee, 0);
  assert.equal(payout.renterDepositReturnTransferFee, 0);
  assert.equal(payout.ownerProcessingFee, 10);
  assert.equal(payout.ownerPayoutAmount, 90);
});

test("final owner payout deducts stored deposit fees when returning a full security deposit", () => {
  const payout = buildFinalOwnerPayoutBreakdown({
    booking: {
      totalPrice: 100,
      priceBreakdown: {
        rentalSubtotal: 100,
        securityDepositAmount: 500,
        securityDepositCollectionProcessingFee: 32.5,
        renterDepositReturnTransferFee: 10,
        ownerPayoutAmount: 47.5,
        ownerPayoutTransferFee: 10,
        transferFeeRule: { rateBps: 0, fixedAmount: 10, calculation: "fixed_only" },
      },
    },
    depositCoveredAmount: 0,
    paidOutstandingAmount: 0,
    depositReturnAmount: 500,
  });

  assert.equal(payout.ownerPayoutGrossAmount, 100);
  assert.equal(payout.ownerPayoutTransferFee, 10);
  assert.equal(payout.securityDepositCollectionProcessingFee, 32.5);
  assert.equal(payout.renterDepositReturnTransferFee, 10);
  assert.equal(payout.ownerProcessingFee, 52.5);
  assert.equal(payout.ownerPayoutAmount, 47.5);
});

test("final owner payout skips deposit return fee when full security deposit is deducted for damage", () => {
  const payout = buildFinalOwnerPayoutBreakdown({
    booking: {
      totalPrice: 100,
      priceBreakdown: {
        rentalSubtotal: 100,
        securityDepositAmount: 500,
        securityDepositCollectionProcessingFee: 32.5,
        renterDepositReturnTransferFee: 10,
        ownerPayoutTransferFee: 10,
        transferFeeRule: { rateBps: 0, fixedAmount: 10, calculation: "fixed_only" },
      },
    },
    depositCoveredAmount: 500,
    paidOutstandingAmount: 0,
    depositReturnAmount: 0,
  });

  assert.equal(payout.ownerPayoutGrossAmount, 600);
  assert.equal(payout.ownerPayoutTransferFee, 10);
  assert.equal(payout.securityDepositCollectionProcessingFee, 32.5);
  assert.equal(payout.renterDepositReturnTransferFee, 0);
  assert.equal(payout.ownerProcessingFee, 42.5);
  assert.equal(payout.ownerPayoutAmount, 557.5);
});

test("final owner payout deducts deposit return fee when a partial security deposit is returned", () => {
  const payout = buildFinalOwnerPayoutBreakdown({
    booking: {
      totalPrice: 100,
      priceBreakdown: {
        rentalSubtotal: 100,
        securityDepositAmount: 500,
        securityDepositCollectionProcessingFee: 32.5,
        renterDepositReturnTransferFee: 10,
        ownerPayoutTransferFee: 10,
        transferFeeRule: { rateBps: 0, fixedAmount: 10, calculation: "fixed_only" },
      },
    },
    depositCoveredAmount: 200,
    paidOutstandingAmount: 0,
    depositReturnAmount: 300,
  });

  assert.equal(payout.ownerPayoutGrossAmount, 300);
  assert.equal(payout.ownerPayoutTransferFee, 10);
  assert.equal(payout.securityDepositCollectionProcessingFee, 32.5);
  assert.equal(payout.renterDepositReturnTransferFee, 10);
  assert.equal(payout.ownerProcessingFee, 52.5);
  assert.equal(payout.ownerPayoutAmount, 247.5);
});

test("owner penalty deduction leaves payout unchanged without open penalties", () => {
  const deduction = buildOwnerPenaltyDeduction({
    ownerPayoutAmount: 900,
    penalties: [
      { id: "closed-1", status: "applied", remainingAmount: 500 },
      { id: "zero-1", status: "open", remainingAmount: 0 },
    ],
  });

  assert.equal(deduction.ownerPayoutAmountBeforePenalty, 900);
  assert.equal(deduction.ownerPenaltyDeductionAmount, 0);
  assert.equal(deduction.ownerPayoutAmountAfterPenalty, 900);
  assert.deepEqual(deduction.applications, []);
});

test("owner penalty deduction fully applies a smaller penalty", () => {
  const deduction = buildOwnerPenaltyDeduction({
    ownerPayoutAmount: 900,
    penalties: [
      {
        id: "penalty-1",
        status: "open",
        remainingAmount: 250,
        sourceBookingId: "cancelled-booking-1",
        approvedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ],
  });

  assert.equal(deduction.ownerPenaltyDeductionAmount, 250);
  assert.equal(deduction.ownerPayoutAmountAfterPenalty, 650);
  assert.deepEqual(deduction.applications, [
    {
      penaltyId: "penalty-1",
      sourceBookingId: "cancelled-booking-1",
      appliedAmount: 250,
      remainingAmountBefore: 250,
      remainingAmountAfter: 0,
      status: "applied",
      currency: "PHP",
    },
  ]);
});

test("owner penalty deduction partially applies a larger penalty", () => {
  const deduction = buildOwnerPenaltyDeduction({
    ownerPayoutAmount: 300,
    penalties: [{ id: "penalty-1", status: "open", remainingAmount: 900 }],
  });

  assert.equal(deduction.ownerPenaltyDeductionAmount, 300);
  assert.equal(deduction.ownerPayoutAmountAfterPenalty, 0);
  assert.deepEqual(deduction.applications, [
    {
      penaltyId: "penalty-1",
      sourceBookingId: "penalty-1",
      appliedAmount: 300,
      remainingAmountBefore: 900,
      remainingAmountAfter: 600,
      status: "partially_applied",
      currency: "PHP",
    },
  ]);
});

test("owner penalty deduction applies multiple penalties oldest first", () => {
  const deduction = buildOwnerPenaltyDeduction({
    ownerPayoutAmount: 600,
    penalties: [
      {
        id: "newer",
        status: "open",
        remainingAmount: 400,
        approvedAt: new Date("2026-01-03T00:00:00.000Z"),
      },
      {
        id: "older",
        status: "partially_applied",
        remainingAmount: 250,
        approvedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ],
  });

  assert.equal(deduction.ownerPenaltyDeductionAmount, 600);
  assert.equal(deduction.ownerPayoutAmountAfterPenalty, 0);
  assert.deepEqual(
    deduction.applications.map((application) => ({
      penaltyId: application.penaltyId,
      appliedAmount: application.appliedAmount,
      remainingAmountAfter: application.remainingAmountAfter,
      status: application.status,
    })),
    [
      { penaltyId: "older", appliedAmount: 250, remainingAmountAfter: 0, status: "applied" },
      { penaltyId: "newer", appliedAmount: 350, remainingAmountAfter: 50, status: "partially_applied" },
    ],
  );
});

test("owner penalty deduction updates booking payout flow", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");
  const booking = applyOwnerPenaltyDeductionToBooking({
    booking: {
      ...fakeSupportBooking(),
      payoutFlow: { ownerPayoutAmount: 900, ownerPayoutTransferFee: 10 },
    },
    deduction: buildOwnerPenaltyDeduction({
      ownerPayoutAmount: 900,
      penalties: [{ id: "penalty-1", status: "open", remainingAmount: 250 }],
    }),
    now,
  });

  assert.equal(booking.payoutFlow.ownerPayoutAmountBeforePenalty, 900);
  assert.equal(booking.payoutFlow.ownerPenaltyDeductionAmount, 250);
  assert.equal(booking.payoutFlow.ownerPayoutAmount, 650);
  assert.equal(booking.payoutFlow.ownerPenaltyApplications.length, 1);
  assert.equal(booking.lastUpdated, now);
});

test("owner penalty application writes asset and owner ledger mirrors", () => {
  const tx = fakeTx();
  const now = new Date("2026-06-01T00:00:00.000Z");
  const booking = fakeSupportBooking();
  const deduction = buildOwnerPenaltyDeduction({
    ownerPayoutAmount: 300,
    penalties: [{ id: "penalty-1", status: "open", remainingAmount: 900 }],
  });

  writeOwnerCancellationPenaltyApplications(tx, {
    db: fakeDb(),
    booking,
    deduction,
    now,
  });

  const writesByPath = new Map(tx.writes.map((write) => [write.path, write]));
  const assetWrite = writesByPath.get("assets/asset-1/ownerPenaltyLedger/penalty-1");
  const ownerWrite = writesByPath.get("users/owner-1/ownerPenaltyLedger/penalty-1");

  assert.deepEqual(assetWrite.payload, {
    remainingAmount: 600,
    status: "partially_applied",
    lastAppliedAmount: 300,
    lastAppliedBookingId: "booking-1",
    lastAppliedAt: now,
    updatedAt: now,
  });
  assert.deepEqual(ownerWrite.payload, assetWrite.payload);
  assert.deepEqual(assetWrite.options, { merge: true });
  assert.deepEqual(ownerWrite.options, { merge: true });
});

test("rejected disputed damage settlement resolves legacy status fields", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");
  const { hasDeposit, updatedBooking } = buildFinalizedBookingSettlement({
    booking: {
      ...fakeSupportBooking(),
      securityDeposit: { enabled: true, amount: 500 },
      depositFlow: {
        required: true,
        amount: 500,
        status: "disputed",
        requestedDeductionAmount: 300,
      },
      disputeFlow: {
        status: "disputed",
        requestedAmount: 300,
        outstandingAmount: 300,
        renterResponse: "disputed",
        supportStatus: "pending",
      },
      damageDeductionRequest: {
        status: "support_review",
        requestedAmount: 300,
        renterResponse: "disputed",
      },
      settlement: {
        status: "support_review",
        supportStatus: "pending",
        damageBalancePaymentStatus: "pending",
        damageBalanceRequestedAmount: 300,
        ownerDamageBalancePayoutStatus: "pending",
      },
      priceBreakdown: {
        rentalSubtotal: 100,
        securityDepositCollectionProcessingFee: 32.5,
        renterDepositReturnTransferFee: 10,
        transferFeeRule: { rateBps: 0, fixedAmount: 10, calculation: "fixed_only" },
      },
    },
    actorId: "admin-1",
    decision: "admin_settled",
    approvedDeductionAmount: 0,
    depositCoveredAmount: 0,
    depositReturnAmount: 500,
    paidOutstandingAmount: 0,
    adminNotes: "Rejected by support",
    now,
  });

  assert.equal(hasDeposit, true);
  assert.equal(updatedBooking.status, "Completed");
  assert.equal(updatedBooking.depositFlow.status, "return_processing");
  assert.equal(updatedBooking.depositFlow.approvedDeductionAmount, 0);
  assert.equal(updatedBooking.depositFlow.depositCoveredAmount, 0);
  assert.equal(updatedBooking.depositFlow.depositReturnAmount, 500);
  assert.equal(updatedBooking.disputeFlow.status, "resolved");
  assert.equal(updatedBooking.disputeFlow.supportStatus, "resolved");
  assert.equal(updatedBooking.disputeFlow.approvedAmount, 0);
  assert.equal(updatedBooking.disputeFlow.depositCoveredAmount, 0);
  assert.equal(updatedBooking.disputeFlow.outstandingAmount, 0);
  assert.equal(updatedBooking.disputeFlow.remainingSecurityDeposit, 500);
  assert.equal(updatedBooking.damageDeductionRequest.status, "resolved");
  assert.equal(updatedBooking.damageDeductionRequest.approvedAmount, 0);
  assert.equal(updatedBooking.settlement.status, "Completed");
  assert.equal(updatedBooking.settlement.supportStatus, "resolved");
  assert.equal(updatedBooking.settlement.approvedDamageDeductionAmount, 0);
  assert.equal(updatedBooking.settlement.depositCoveredDamageAmount, 0);
  assert.equal(updatedBooking.settlement.outstandingDamageAmount, 0);
  assert.equal(updatedBooking.settlement.depositReturnAmount, 500);
  assert.equal(updatedBooking.settlement.damageBalancePaymentStatus, null);
  assert.equal(updatedBooking.settlement.damageBalanceRequestedAmount, null);
  assert.equal(updatedBooking.settlement.damageBalancePaymentRequestId, null);
  assert.equal(updatedBooking.settlement.ownerDamageBalancePayoutStatus, null);
});

test("outstanding damage payment message extra includes mobile payment action fields", () => {
  const extra = buildOutstandingDamagePaymentMessageExtra({
    paymentRequestId: "damage-payment-1",
    amount: 700,
    currency: "PHP",
  });

  assert.deepEqual(extra, {
    damagePaymentRequestId: "damage-payment-1",
    paymentRequestId: "damage-payment-1",
    paymentStatus: "pending",
    amount: 700,
    currency: "PHP",
  });
});

test("outstanding damage payment state treats admin amount as balance beyond security deposit", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const state = buildOutstandingDamagePaymentState({
    booking: {
      ...fakeSupportBooking(),
      securityDeposit: { enabled: true, amount: 500 },
      depositFlow: { required: true, amount: 500, status: "support_review" },
      disputeFlow: { status: "support_review" },
    },
    paymentAmount: 200,
    paymentRequestId: "damage-payment-1",
    now,
  });

  assert.equal(state.depositFlow.status, "outstanding_payment_pending");
  assert.equal(state.depositFlow.approvedDeductionAmount, 700);
  assert.equal(state.depositFlow.depositCoveredAmount, 500);
  assert.equal(state.depositFlow.depositReturnAmount, 0);
  assert.equal(state.disputeFlow.approvedAmount, 700);
  assert.equal(state.disputeFlow.depositCoveredAmount, 500);
  assert.equal(state.disputeFlow.outstandingAmount, 200);
  assert.equal(state.disputeFlow.outstandingPaymentStatus, "pending");
  assert.equal(state.settlement.approvedDamageDeductionAmount, 700);
  assert.equal(state.settlement.depositCoveredDamageAmount, 500);
  assert.equal(state.settlement.outstandingDamageAmount, 200);
  assert.equal(state.settlement.damageBalancePaymentStatus, "pending");
});

test("outstanding damage payment state treats admin amount as full damage payment without deposit", () => {
  const state = buildOutstandingDamagePaymentState({
    booking: {
      ...fakeSupportBooking(),
      securityDeposit: { enabled: false, amount: 0 },
      depositFlow: { required: false, amount: 0, status: "none" },
      disputeFlow: { status: "support_review" },
    },
    paymentAmount: 200,
    paymentRequestId: "damage-payment-1",
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.equal(state.disputeFlow.approvedAmount, 200);
  assert.equal(state.disputeFlow.depositCoveredAmount, 0);
  assert.equal(state.disputeFlow.outstandingAmount, 200);
  assert.equal(state.settlement.approvedDamageDeductionAmount, 200);
  assert.equal(state.settlement.depositCoveredDamageAmount, 0);
  assert.equal(state.settlement.outstandingDamageAmount, 200);
});

test("outstanding damage payment request rejects duplicate pending or paid states", () => {
  assert.throws(() => assertCanRequestOutstandingDamagePayment({
    disputeFlow: { outstandingPaymentStatus: "pending" },
  }));
  assert.throws(() => assertCanRequestOutstandingDamagePayment({
    settlement: { damageBalancePaymentStatus: "paid" },
  }));
  assert.doesNotThrow(() => assertCanRequestOutstandingDamagePayment({
    disputeFlow: { outstandingPaymentStatus: "failed" },
  }));
});

test("outstanding damage payment amount must be whole and positive", () => {
  assert.equal(normalizeWholePositiveAmount(200, "amount"), 200);
  assert.throws(() => normalizeWholePositiveAmount(0, "amount"));
  assert.throws(() => normalizeWholePositiveAmount(10.5, "amount"));
});

test("paid outstanding damage updates settlement status for admin release visibility", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const paymentRecord = {
    requestId: "damage-payment-1",
    amount: 200,
    paidAt: now,
  };
  const updatedBooking = buildOutstandingDamagePaidBookingState({
    booking: {
      ...fakeSupportBooking(),
      depositFlow: { status: "outstanding_payment_pending" },
      disputeFlow: {
        status: "outstanding_payment_pending",
        outstandingAmount: 200,
        outstandingPaymentStatus: "pending",
      },
      settlement: {
        status: "outstanding_payment_pending",
        damageBalancePaymentStatus: "pending",
        damageBalanceRequestedAmount: 200,
        outstandingDamageAmount: 200,
      },
    },
    amount: 200,
    paymentRecord,
    now,
  });

  assert.equal(updatedBooking.disputeFlow.status, "outstanding_paid");
  assert.equal(updatedBooking.disputeFlow.outstandingPaymentStatus, "paid");
  assert.equal(updatedBooking.disputeFlow.paidOutstandingAmount, 200);
  assert.deepEqual(updatedBooking.disputeFlow.outstandingPayment, paymentRecord);
  assert.equal(updatedBooking.settlement.status, "outstanding_paid");
  assert.equal(updatedBooking.settlement.damageBalancePaymentStatus, "paid");
  assert.equal(updatedBooking.settlement.damageBalanceRequestedAmount, 200);
  assert.equal(updatedBooking.settlement.outstandingDamageAmount, 200);
  assert.equal(updatedBooking.settlement.ownerDamageBalancePayoutStatus, null);
});

test("PayMongo webhook helpers read event metadata from canonical payloads", () => {
  const payload = {
    data: {
      id: "evt_123",
      attributes: {
        type: "payment.paid",
        data: {
          id: "pay_123",
          attributes: {
            payment_intent_id: "pi_123",
          },
        },
      },
    },
  };

  assert.equal(getPayMongoEventId(payload), "evt_123");
  assert.equal(getPayMongoEventType(payload), "payment.paid");
  assert.equal(getPayMongoPaymentIntentId(payload), "pi_123");
});

test("PayMongo webhook helpers tolerate relationship-based payment intent payloads", () => {
  const payload = {
    id: "evt_456",
    type: "payment.failed",
    data: {
      attributes: {
        data: {
          relationships: {
            payment_intent: {
              data: {
                id: "pi_456",
              },
            },
          },
        },
      },
    },
  };

  assert.equal(getPayMongoEventId(payload), "evt_456");
  assert.equal(getPayMongoEventType(payload), "payment.failed");
  assert.equal(getPayMongoPaymentIntentId(payload), "pi_456");
});

test("PayMongo Payment Intent attributes omit card vaulting unless explicitly requested", () => {
  const attrs = buildPaymentIntentAttributes({
    amount: 2000,
    description: "Test checkout",
    paymentMethods: ["card"],
    metadata: { checkout_id: "checkout_123" },
  });

  assert.equal(attrs.amount, 2000);
  assert.deepEqual(attrs.payment_method_allowed, ["card"]);
  assert.equal(attrs.setup_future_usage, undefined);
});

test("PayMongo Payment Intent attributes include customer card vaulting setup", () => {
  const attrs = buildPaymentIntentAttributes({
    amount: 2000,
    description: "Test checkout",
    paymentMethods: ["card"],
    metadata: { checkout_id: "checkout_123" },
    setupFutureUsage: {
      session_type: "on_session",
      customer_id: "cus_test_123",
    },
  });

  assert.deepEqual(attrs.setup_future_usage, {
    session_type: "on_session",
    customer_id: "cus_test_123",
  });
});

test("PayMongo Subscription plan and subscription attributes use documented recurring fields", () => {
  const planAttrs = buildSubscriptionPlanAttributes({
    amount: 300000,
    currency: "PHP",
    cycleCount: 4,
    description: "Monthly rental",
    interval: "monthly",
    intervalCount: 1,
    name: "Lend monthly rental",
    metadata: { checkout_id: "checkout_123" },
  });
  const subscriptionAttrs = buildSubscriptionAttributes({
    anchorDate: "2026-02-01",
    customerId: "cus_123",
    planId: "plan_123",
    returnUrl: "https://getlend.dev/payment/return?checkoutId=checkout_123",
    metadata: { checkout_id: "checkout_123" },
  });

  assert.equal(planAttrs.type, "scheduled");
  assert.equal(planAttrs.amount, 300000);
  assert.equal(planAttrs.cycle_count, 4);
  assert.equal(planAttrs.interval, "monthly");
  assert.equal(subscriptionAttrs.anchor_date, "2026-02-01");
  assert.equal(subscriptionAttrs.customer_id, "cus_123");
  assert.equal(subscriptionAttrs.plan_id, "plan_123");
});

test("PayMongo amount conversion sends peso amounts as centavos", () => {
  assert.equal(toPayMongoAmount(603.23), 60323);
  assert.equal(toPayMongoAmount(85.5), 8550);
  assert.equal(toPayMongoAmount(100), 10000);
});

test("outstanding damage checkout keeps payment amount in pesos and PayMongo amount in centavos", () => {
  const policy = normalizePricingPolicyConfig(DEFAULT_PRICING_POLICY);
  const pricing = buildOutstandingDamagePriceBreakdown({
    amount: 800,
    policy,
    selectedPaymentMethod: "card",
    selectedPaymentMethodDetails: {},
    currency: "PHP",
  });

  assert.equal(pricing.outstandingDamageAmount, 800);
  assert.equal(pricing.renterProcessingFee, 43);
  assert.equal(pricing.paymentAmount, 843);
  assert.equal(pricing.paymongoPaymentAmount, 84300);
  assert.equal(pricing.currency, "PHP");
});

test("client checkout cancellation only allows open checkout statuses", () => {
  assert.equal(isClientCancellableCheckoutStatus("initialized"), true);
  assert.equal(isClientCancellableCheckoutStatus("processing"), true);
  assert.equal(isClientCancellableCheckoutStatus("subscription_pending"), true);
  assert.equal(isClientCancellableCheckoutStatus("booked"), false);
  assert.equal(isClientCancellableCheckoutStatus("failed"), false);
  assert.equal(isClientCancellableCheckoutStatus("expired"), false);
});

test("client checkout cancellation reason is normalized and bounded", () => {
  const reason = normalizeClientCancelReason(` ${"x".repeat(600)} `);

  assert.equal(reason.length, 240);
  assert.equal(normalizeClientCancelReason("   "), "Payment was cancelled");
});

test("terminal recovery result does not reopen pending checkout", () => {
  const result = terminalRecoveryResult({
    status: "failed",
    paymentStatus: "failed",
    bookingId: null,
    chatId: null,
  });

  assert.equal(result.success, true);
  assert.equal(result.hasPendingCheckout, false);
  assert.equal(result.status, "failed");
  assert.equal(result.paymentStatus, "failed");
});

test("payout institutions are grouped by transfer provider", () => {
  const instapayPayload = {
    data: [
      {
        id: "bdo-instapay",
        attributes: {
          id: "bdo",
          name: "BDO Unibank",
          code: "BDO",
          destination_type: "bank",
        },
      },
      {
        id: "gcash-instapay",
        attributes: {
          id: "gcash",
          name: "GCash",
          code: "GCASH",
          destination_type: "ewallet",
        },
      },
    ],
  };
  const pesonetPayload = {
    data: [
      {
        id: "bdo-pesonet",
        attributes: {
          id: "bdo",
          name: "BDO Unibank",
          code: "BDO",
          destination_type: "bank",
        },
      },
    ],
  };

  const result = buildProviderPayoutInstitutionLists({
    instapayPayload,
    pesonetPayload,
    destinationType: "bank",
  });

  assert.deepEqual(
    result.instapayInstitutions.map((institution) => institution.supportedProviders),
    [["instapay"]],
  );
  assert.deepEqual(
    result.pesonetInstitutions.map((institution) => institution.supportedProviders),
    [["pesonet"]],
  );
  assert.equal(result.instapayInstitutions.length, 1);
  assert.equal(result.pesonetInstitutions.length, 1);
  assert.deepEqual(result.institutions[0].supportedProviders, ["instapay", "pesonet"]);
});
