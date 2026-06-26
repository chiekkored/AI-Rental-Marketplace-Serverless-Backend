const admin = require("firebase-admin");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { FUNCTIONS_REGION } = require("../utils/functionsRegion.util");
const {
  bookingFinancialContribution,
  booleanDelta,
  currentMonthKey,
  isActiveBooking,
  isActiveListing,
  isPendingCancellation,
  isPendingDamage,
  isPendingReport,
  isPendingStatus,
  isPendingVerification,
  monthLabel,
  roundCurrency,
} = require("../utils/adminDashboardMetrics.util");

const DASHBOARD_PATH = "adminMetrics/dashboard";
const EVENT_RETENTION_DAYS = 30;

function dashboardRef(db) {
  return db.doc(DASHBOARD_PATH);
}

function revenueMonthRef(db, monthKey) {
  return dashboardRef(db).collection("revenueMonths").doc(monthKey);
}

function categoryMonthRef(db, monthKey) {
  return dashboardRef(db).collection("categoryActivity").doc(monthKey);
}

function metricEventRef(db, eventId) {
  return db.collection("adminMetricEvents").doc(safeDocumentId(eventId));
}

function activityRef(db, eventId) {
  return db.collection("adminActivityFeed").doc(safeDocumentId(eventId));
}

async function applyCounterEvent(event, { activity, deltas, source }) {
  const relevantDeltas = Object.fromEntries(
    Object.entries(deltas).filter(([, value]) => Number(value || 0) !== 0),
  );
  if (!Object.keys(relevantDeltas).length && !activity) return null;

  const db = admin.firestore();
  const markerRef = metricEventRef(db, event.id);
  const metricsRef = dashboardRef(db);
  const now = new Date();

  await db.runTransaction(async (transaction) => {
    const markerSnapshot = await transaction.get(markerRef);
    if (markerSnapshot.exists) return;
    const dashboardSnapshot = await transaction.get(metricsRef);
    const dashboard = normalizeDashboard(dashboardSnapshot.data(), currentMonthKey(now));

    for (const [field, delta] of Object.entries(relevantDeltas)) {
      dashboard[field] = Math.max(Number(dashboard[field] || 0) + Number(delta), 0);
    }
    dashboard.updatedAt = admin.firestore.FieldValue?.serverTimestamp() || now;

    transaction.set(metricsRef, dashboard, { merge: true });
    if (activity) {
      transaction.set(activityRef(db, event.id), {
        ...activity,
        occurredAt: activity.occurredAt || dashboard.updatedAt,
        source,
      });
    }
    transaction.set(markerRef, {
      createdAt: dashboard.updatedAt,
      expiresAt: new Date(now.getTime() + EVENT_RETENTION_DAYS * 86400000),
      source,
    });
  });

  return null;
}

async function applyBookingEvent(event) {
  const before = snapshotData(event.data?.before);
  const after = snapshotData(event.data?.after);
  const beforeContribution = bookingFinancialContribution(before);
  const afterContribution = bookingFinancialContribution(after);
  const countDeltas = {
    activeBookings: booleanDelta(before, after, isActiveBooking),
    pendingCancellations: booleanDelta(before, after, isPendingCancellation),
    pendingDamage: booleanDelta(before, after, isPendingDamage),
  };
  const activity = bookingActivity(before, after, event.params.bookingId);

  if (
    !beforeContribution &&
    !afterContribution &&
    !Object.values(countDeltas).some(Boolean) &&
    !activity
  ) {
    return null;
  }

  const db = admin.firestore();
  const markerRef = metricEventRef(db, event.id);
  const metricsRef = dashboardRef(db);
  const monthKeys = [...new Set(
    [beforeContribution?.monthKey, afterContribution?.monthKey].filter(Boolean),
  )];
  const now = new Date();
  const currentKey = currentMonthKey(now);

  await db.runTransaction(async (transaction) => {
    const markerSnapshot = await transaction.get(markerRef);
    if (markerSnapshot.exists) return;
    const dashboardSnapshot = await transaction.get(metricsRef);
    const revenueSnapshots = new Map();
    const categorySnapshots = new Map();

    for (const monthKey of monthKeys) {
      revenueSnapshots.set(monthKey, await transaction.get(revenueMonthRef(db, monthKey)));
      categorySnapshots.set(monthKey, await transaction.get(categoryMonthRef(db, monthKey)));
    }

    const dashboard = normalizeDashboard(dashboardSnapshot.data(), currentKey);
    for (const [field, delta] of Object.entries(countDeltas)) {
      dashboard[field] = Math.max(Number(dashboard[field] || 0) + Number(delta), 0);
    }

    for (const contribution of [beforeContribution, afterContribution]) {
      if (!contribution || contribution.monthKey !== currentKey) continue;
      const direction = contribution === beforeContribution ? -1 : 1;
      dashboard.netLendRevenueMonth = roundCurrency(
        dashboard.netLendRevenueMonth + direction * contribution.netLendRevenue,
      );
      dashboard.grossPaymentVolumeMonth = roundCurrency(
        dashboard.grossPaymentVolumeMonth + direction * contribution.grossPaymentVolume,
      );
      dashboard.rentalGmvMonth = roundCurrency(
        dashboard.rentalGmvMonth + direction * contribution.rentalGmv,
      );
    }

    const updatedAt = admin.firestore.FieldValue?.serverTimestamp() || now;
    dashboard.updatedAt = updatedAt;
    transaction.set(metricsRef, dashboard, { merge: true });

    for (const monthKey of monthKeys) {
      const revenue = normalizeRevenueMonth(revenueSnapshots.get(monthKey)?.data(), monthKey);
      const categories = normalizeCategoryMonth(categorySnapshots.get(monthKey)?.data(), monthKey);
      applyContribution(revenue, categories, beforeContribution, monthKey, -1);
      applyContribution(revenue, categories, afterContribution, monthKey, 1);
      revenue.updatedAt = updatedAt;
      categories.updatedAt = updatedAt;
      transaction.set(revenueMonthRef(db, monthKey), revenue);
      transaction.set(categoryMonthRef(db, monthKey), categories);
    }

    if (activity) {
      transaction.set(activityRef(db, event.id), {
        ...activity,
        occurredAt: activity.occurredAt || updatedAt,
        source: "bookings",
      });
    }
    transaction.set(markerRef, {
      createdAt: updatedAt,
      expiresAt: new Date(now.getTime() + EVENT_RETENTION_DAYS * 86400000),
      source: "bookings",
    });
  });

  return null;
}

function applyContribution(revenue, categories, contribution, monthKey, direction) {
  if (!contribution || contribution.monthKey !== monthKey) return;
  revenue.bookingCount = Math.max(revenue.bookingCount + direction * contribution.bookingCount, 0);
  revenue.netLendRevenue = roundCurrency(
    revenue.netLendRevenue + direction * contribution.netLendRevenue,
  );
  revenue.grossPaymentVolume = roundCurrency(
    revenue.grossPaymentVolume + direction * contribution.grossPaymentVolume,
  );
  revenue.rentalGmv = roundCurrency(revenue.rentalGmv + direction * contribution.rentalGmv);

  const key = categoryKey(contribution.categoryName);
  const current = categories.categories[key] || {
    bookingCount: 0,
    categoryName: contribution.categoryName,
    rentalGmv: 0,
  };
  current.bookingCount = Math.max(current.bookingCount + direction * contribution.bookingCount, 0);
  current.rentalGmv = roundCurrency(current.rentalGmv + direction * contribution.rentalGmv);
  if (current.bookingCount === 0 && current.rentalGmv === 0) {
    delete categories.categories[key];
  } else {
    categories.categories[key] = current;
  }
}

function normalizeDashboard(data, monthKey) {
  const current = data || {};
  const sameMonth = current.monthKey === monthKey;
  return {
    activeBookings: Number(current.activeBookings || 0),
    activeListings: Number(current.activeListings || 0),
    grossPaymentVolumeMonth: sameMonth ? Number(current.grossPaymentVolumeMonth || 0) : 0,
    monthKey,
    netLendRevenueMonth: sameMonth ? Number(current.netLendRevenueMonth || 0) : 0,
    pendingApprovals: Number(current.pendingApprovals || 0),
    pendingCancellations: Number(current.pendingCancellations || 0),
    pendingDamage: Number(current.pendingDamage || 0),
    pendingReports: Number(current.pendingReports || 0),
    rentalGmvMonth: sameMonth ? Number(current.rentalGmvMonth || 0) : 0,
    totalUsers: Number(current.totalUsers || 0),
  };
}

function normalizeRevenueMonth(data, monthKey) {
  return {
    bookingCount: Number(data?.bookingCount || 0),
    grossPaymentVolume: Number(data?.grossPaymentVolume || 0),
    label: monthLabel(monthKey),
    monthKey,
    netLendRevenue: Number(data?.netLendRevenue || 0),
    rentalGmv: Number(data?.rentalGmv || 0),
  };
}

function normalizeCategoryMonth(data, monthKey) {
  return {
    categories: data?.categories && typeof data.categories === "object" ? { ...data.categories } : {},
    monthKey,
  };
}

function snapshotData(snapshot) {
  return snapshot?.exists ? snapshot.data() : null;
}

function userActivity(before, after, uid) {
  if (!before && after) {
    return {
      entityId: uid,
      href: `/admin/users/all-users`,
      status: after.status || "Active",
      subject: displayName(after) || after.email || uid,
      title: "New user registration",
      type: "user",
    };
  }
  return null;
}

function assetActivity(before, after, assetId) {
  if (!after) return null;
  if (!before || before.status !== after.status) {
    return {
      entityId: assetId,
      href: "/admin/listings/all",
      status: after.status || "Unknown",
      subject: after.title || assetId,
      title: before ? "Listing status changed" : "New listing",
      type: "listing",
    };
  }
  return null;
}

function bookingActivity(before, after, bookingId) {
  if (!after) return null;
  const becamePaid = !bookingFinancialContribution(before) && bookingFinancialContribution(after);
  if (!before || before.status !== after.status || becamePaid) {
    return {
      entityId: bookingId,
      href: "/admin/bookings/all",
      status: after.status || "Unknown",
      subject: after.asset?.title || after.assetId || bookingId,
      title: becamePaid ? "Booking payment received" : before ? "Booking status changed" : "New booking",
      type: "booking",
    };
  }
  return null;
}

function reportActivity(before, after, reportId) {
  if (!after) return null;
  if (!before || before.status !== after.status) {
    return {
      entityId: reportId,
      href: "/admin/reports/other",
      status: after.status || "Pending",
      subject: after.reason || after.reportType || reportId,
      title: before ? "Report status changed" : "New report",
      type: "report",
    };
  }
  return null;
}

function queueActivity(before, after, id, { href, label, subjectField }) {
  if (!after) return null;
  if (!before || before.status !== after.status) {
    return {
      entityId: id,
      href,
      status: after.status || "Pending",
      subject: after[subjectField] || after.title || after.ownerId || id,
      title: before ? `${label} status changed` : `New ${label.toLowerCase()}`,
      type: "approval",
    };
  }
  return null;
}

function displayName(data) {
  return data.displayName || [data.firstName, data.lastName].filter(Boolean).join(" ").trim();
}

function categoryKey(value) {
  const normalized = String(value || "Uncategorized")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  return normalized || "uncategorized";
}

function safeDocumentId(value) {
  return String(value || "unknown").replace(/\//g, "_");
}

const triggerOptions = (document) => ({ document, region: FUNCTIONS_REGION });

const updateDashboardUsers = onDocumentWritten(
  triggerOptions("users/{uid}"),
  (event) => {
    const before = snapshotData(event.data?.before);
    const after = snapshotData(event.data?.after);
    return applyCounterEvent(event, {
      activity: userActivity(before, after, event.params.uid),
      deltas: {
        pendingApprovals: booleanDelta(before, after, isPendingVerification),
        totalUsers: Number(Boolean(after)) - Number(Boolean(before)),
      },
      source: "users",
    });
  },
);

const updateDashboardAssets = onDocumentWritten(
  triggerOptions("assets/{assetId}"),
  (event) => {
    const before = snapshotData(event.data?.before);
    const after = snapshotData(event.data?.after);
    return applyCounterEvent(event, {
      activity: assetActivity(before, after, event.params.assetId),
      deltas: {
        activeListings: booleanDelta(before, after, isActiveListing),
      },
      source: "assets",
    });
  },
);

const updateDashboardBookings = onDocumentWritten(
  triggerOptions("bookings/{bookingId}"),
  applyBookingEvent,
);

const updateDashboardReports = onDocumentWritten(
  triggerOptions("reports/{reportId}"),
  (event) => {
    const before = snapshotData(event.data?.before);
    const after = snapshotData(event.data?.after);
    return applyCounterEvent(event, {
      activity: reportActivity(before, after, event.params.reportId),
      deltas: {
        pendingReports: booleanDelta(before, after, isPendingReport),
      },
      source: "reports",
    });
  },
);

function approvalTrigger(document, options) {
  return onDocumentWritten(triggerOptions(document), (event) => {
    const before = snapshotData(event.data?.before);
    const after = snapshotData(event.data?.after);
    const id = event.params[options.param];
    return applyCounterEvent(event, {
      activity: queueActivity(before, after, id, options),
      deltas: {
        pendingApprovals: booleanDelta(before, after, isPendingStatus),
      },
      source: options.source,
    });
  });
}

const updateDashboardListingReviews = approvalTrigger(
  "listingReviewSubmissions/{submissionId}",
  {
    href: "/admin/listings/ai-review-queue",
    label: "Listing review",
    param: "submissionId",
    source: "listingReviewSubmissions",
    subjectField: "assetId",
  },
);
const updateDashboardBusinessSubmissions = approvalTrigger(
  "businessRegistrationSubmissions/{ownerId}",
  {
    href: "/admin/business/submissions",
    label: "Business submission",
    param: "ownerId",
    source: "businessRegistrationSubmissions",
    subjectField: "businessName",
  },
);
const updateDashboardDeactivationRequests = approvalTrigger(
  "listingDeactivationRequests/{requestId}",
  {
    href: "/admin/listings/deactivation-requests",
    label: "Deactivation request",
    param: "requestId",
    source: "listingDeactivationRequests",
    subjectField: "assetId",
  },
);

module.exports = {
  updateDashboardAssets,
  updateDashboardBookings,
  updateDashboardBusinessSubmissions,
  updateDashboardDeactivationRequests,
  updateDashboardListingReviews,
  updateDashboardReports,
  updateDashboardUsers,
  _test: {
    applyContribution,
    normalizeCategoryMonth,
    normalizeDashboard,
    normalizeRevenueMonth,
  },
};
