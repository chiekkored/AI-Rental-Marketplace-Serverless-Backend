const admin = require("firebase-admin");

const NOTIFICATION_PREFERENCES_COLLECTION = "private";
const NOTIFICATION_PREFERENCES_DOC = "notificationPreferences";

const PUSH_CATEGORIES = {
  messages: "messages",
  bookings: "bookings",
  payments: "payments",
  listings: "listings",
  verification: "verification",
};

const EMAIL_CATEGORIES = {
  bookings: "bookings",
  payments: "payments",
};

const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  version: 1,
  channels: Object.freeze({
    push: true,
  }),
  pushCategories: Object.freeze({
    messages: true,
    bookings: true,
    payments: true,
    listings: true,
    verification: true,
  }),
  emailCategories: Object.freeze({
    bookings: true,
    payments: true,
  }),
});

function notificationPreferencesRef(db, uid) {
  return db
    .collection("users")
    .doc(uid)
    .collection(NOTIFICATION_PREFERENCES_COLLECTION)
    .doc(NOTIFICATION_PREFERENCES_DOC);
}

async function getNotificationPreferences(uid, adminClient = admin) {
  if (!uid) return defaultNotificationPreferences();

  try {
    const snap = await notificationPreferencesRef(adminClient.firestore(), uid).get();
    return normalizeNotificationPreferences(snap.exists ? snap.data() : null);
  } catch (_) {
    return defaultNotificationPreferences();
  }
}

function defaultNotificationPreferences() {
  return {
    version: DEFAULT_NOTIFICATION_PREFERENCES.version,
    channels: { ...DEFAULT_NOTIFICATION_PREFERENCES.channels },
    pushCategories: { ...DEFAULT_NOTIFICATION_PREFERENCES.pushCategories },
    emailCategories: { ...DEFAULT_NOTIFICATION_PREFERENCES.emailCategories },
  };
}

function normalizeNotificationPreferences(value = {}) {
  const defaults = defaultNotificationPreferences();
  const source = value && typeof value === "object" ? value : {};

  return {
    version: 1,
    channels: {
      push: boolOrDefault(source.channels?.push, defaults.channels.push),
    },
    pushCategories: normalizeBooleanMap(source.pushCategories, defaults.pushCategories),
    emailCategories: normalizeBooleanMap(source.emailCategories, defaults.emailCategories),
  };
}

function validateNotificationPreferencesUpdate(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Preferences must be an object");
  }

  const allowedTopLevel = new Set(["channels", "pushCategories", "emailCategories"]);
  assertOnlyKeys(value, allowedTopLevel, "preferences");

  if ("channels" in value) {
    assertBooleanMap(value.channels, new Set(["push"]), "channels");
  }

  if ("pushCategories" in value) {
    assertBooleanMap(value.pushCategories, new Set(Object.values(PUSH_CATEGORIES)), "pushCategories");
  }

  if ("emailCategories" in value) {
    assertBooleanMap(value.emailCategories, new Set(Object.values(EMAIL_CATEGORIES)), "emailCategories");
  }

  return normalizeNotificationPreferences(value);
}

function buildNotificationPreferencesWrite({ preferences, uid }, adminClient = admin) {
  return {
    ...preferences,
    updatedAt: adminClient.firestore?.FieldValue?.serverTimestamp() || new Date(),
    updatedBy: uid,
  };
}

async function shouldSendPushToUser({ category, data = {}, uid }, adminClient = admin) {
  const preferences = await getNotificationPreferences(uid, adminClient);
  if (preferences.channels.push !== true) return false;

  const resolvedCategory = category || resolvePushCategory(data);
  if (!resolvedCategory) return true;

  return preferences.pushCategories[resolvedCategory] !== false;
}

async function shouldSendOptionalEmailToUser({ category, uid }, adminClient = admin) {
  if (!Object.values(EMAIL_CATEGORIES).includes(category)) return true;
  const preferences = await getNotificationPreferences(uid, adminClient);
  return preferences.emailCategories[category] !== false;
}

function resolvePushCategory(data = {}) {
  const explicit = typeof data.notificationCategory === "string" ? data.notificationCategory.trim() : "";
  if (Object.values(PUSH_CATEGORIES).includes(explicit)) return explicit;

  switch (data.type) {
    case "chat":
      return PUSH_CATEGORIES.messages;
    case "booking":
      return PUSH_CATEGORIES.bookings;
    case "deposit_return_processing":
    case "owner_payout_processing":
    case "manual_user_payout":
      return PUSH_CATEGORIES.payments;
    case "listing_review":
    case "listing_moderation":
    case "listing_deactivation":
      return PUSH_CATEGORIES.listings;
    case "verification":
    case "business_registration":
      return PUSH_CATEGORIES.verification;
    default:
      return null;
  }
}

function normalizeBooleanMap(source, defaults) {
  const value = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  return Object.fromEntries(
    Object.entries(defaults).map(([key, defaultValue]) => [key, boolOrDefault(value[key], defaultValue)]),
  );
}

function boolOrDefault(value, defaultValue) {
  return typeof value === "boolean" ? value : defaultValue;
}

function assertBooleanMap(value, allowedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertOnlyKeys(value, allowedKeys, label);
  Object.entries(value).forEach(([key, item]) => {
    if (typeof item !== "boolean") {
      throw new Error(`${label}.${key} must be a boolean`);
    }
  });
}

function assertOnlyKeys(value, allowedKeys, label) {
  Object.keys(value || {}).forEach((key) => {
    if (!allowedKeys.has(key)) {
      throw new Error(`${label}.${key} is not supported`);
    }
  });
}

module.exports = {
  EMAIL_CATEGORIES,
  NOTIFICATION_PREFERENCES_DOC,
  PUSH_CATEGORIES,
  buildNotificationPreferencesWrite,
  defaultNotificationPreferences,
  getNotificationPreferences,
  notificationPreferencesRef,
  normalizeNotificationPreferences,
  resolvePushCategory,
  shouldSendOptionalEmailToUser,
  shouldSendPushToUser,
  validateNotificationPreferencesUpdate,
};
