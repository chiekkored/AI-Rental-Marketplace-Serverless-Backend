const admin = require("firebase-admin");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { throwAndLogHttpsError } = require("../utils/error.util");
const { FUNCTIONS_REGION } = require("../utils/functionsRegion.util");
const {
  bookingFinancialContribution,
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

async function rebuildAdminDashboardMetricsRun() {
  const db = admin.firestore();
  const [
    usersSnapshot,
    assetsSnapshot,
    bookingsSnapshot,
    reportsSnapshot,
    listingReviewsSnapshot,
    businessSubmissionsSnapshot,
    deactivationRequestsSnapshot,
    existingRevenueSnapshot,
    existingCategorySnapshot,
  ] = await Promise.all([
    db.collection("users").get(),
    db.collection("assets").get(),
    db.collection("bookings").get(),
    db.collection("reports").get(),
    db.collection("listingReviewSubmissions").get(),
    db.collection("businessRegistrationSubmissions").get(),
    db.collection("listingDeactivationRequests").get(),
    db.doc("adminMetrics/dashboard").collection("revenueMonths").get(),
    db.doc("adminMetrics/dashboard").collection("categoryActivity").get(),
  ]);

  const users = usersSnapshot.docs.map((doc) => doc.data());
  const assets = assetsSnapshot.docs.map((doc) => doc.data());
  const bookings = bookingsSnapshot.docs.map((doc) => doc.data());
  const reports = reportsSnapshot.docs.map((doc) => doc.data());
  const currentKey = currentMonthKey();
  const revenueMonths = new Map();
  const categoryMonths = new Map();

  for (const booking of bookings) {
    const contribution = bookingFinancialContribution(booking);
    if (!contribution) continue;
    const revenue = revenueMonths.get(contribution.monthKey) || emptyRevenueMonth(contribution.monthKey);
    revenue.bookingCount += 1;
    revenue.grossPaymentVolume = roundCurrency(
      revenue.grossPaymentVolume + contribution.grossPaymentVolume,
    );
    revenue.netLendRevenue = roundCurrency(
      revenue.netLendRevenue + contribution.netLendRevenue,
    );
    revenue.rentalGmv = roundCurrency(revenue.rentalGmv + contribution.rentalGmv);
    revenueMonths.set(contribution.monthKey, revenue);

    const categories = categoryMonths.get(contribution.monthKey) || {};
    const key = categoryKey(contribution.categoryName);
    const category = categories[key] || {
      bookingCount: 0,
      categoryName: contribution.categoryName,
      rentalGmv: 0,
    };
    category.bookingCount += 1;
    category.rentalGmv = roundCurrency(category.rentalGmv + contribution.rentalGmv);
    categories[key] = category;
    categoryMonths.set(contribution.monthKey, categories);
  }

  const currentRevenue = revenueMonths.get(currentKey) || emptyRevenueMonth(currentKey);
  const pendingApprovals =
    users.filter(isPendingVerification).length +
    listingReviewsSnapshot.docs.filter((doc) => isPendingStatus(doc.data())).length +
    businessSubmissionsSnapshot.docs.filter((doc) => isPendingStatus(doc.data())).length +
    deactivationRequestsSnapshot.docs.filter((doc) => isPendingStatus(doc.data())).length;
  const updatedAt = admin.firestore.FieldValue?.serverTimestamp() || new Date();
  const writes = [
    {
      data: {
        activeBookings: bookings.filter(isActiveBooking).length,
        activeListings: assets.filter(isActiveListing).length,
        grossPaymentVolumeMonth: currentRevenue.grossPaymentVolume,
        monthKey: currentKey,
        netLendRevenueMonth: currentRevenue.netLendRevenue,
        pendingApprovals,
        pendingCancellations: bookings.filter(isPendingCancellation).length,
        pendingDamage: bookings.filter(isPendingDamage).length,
        pendingReports: reports.filter(isPendingReport).length,
        rentalGmvMonth: currentRevenue.rentalGmv,
        totalUsers: users.length,
        updatedAt,
      },
      ref: db.doc("adminMetrics/dashboard"),
    },
  ];

  for (const [monthKey, revenue] of revenueMonths) {
    writes.push({
      data: { ...revenue, updatedAt },
      ref: db.doc(`adminMetrics/dashboard/revenueMonths/${monthKey}`),
    });
    writes.push({
      data: {
        categories: categoryMonths.get(monthKey) || {},
        monthKey,
        updatedAt,
      },
      ref: db.doc(`adminMetrics/dashboard/categoryActivity/${monthKey}`),
    });
  }

  for (const document of existingRevenueSnapshot.docs) {
    if (!revenueMonths.has(document.id)) {
      writes.push({ delete: true, ref: document.ref });
    }
  }
  for (const document of existingCategorySnapshot.docs) {
    if (!categoryMonths.has(document.id)) {
      writes.push({ delete: true, ref: document.ref });
    }
  }

  await commitWrites(db, writes);
  const summary = {
    bookings: bookings.length,
    months: revenueMonths.size,
    totalUsers: users.length,
  };
  console.log("[rebuildAdminDashboardMetrics] complete", summary);
  return summary;
}

async function adminRebuildDashboardMetrics(request) {
  if (request.auth?.token?.admin !== true) {
    throwAndLogHttpsError("permission-denied", "Only admins can rebuild dashboard metrics");
  }

  try {
    return {
      success: true,
      summary: await rebuildAdminDashboardMetricsRun(),
    };
  } catch (error) {
    throwAndLogHttpsError("internal", error.message || "Unable to rebuild dashboard metrics");
  }
}

const rebuildAdminDashboardMetricsScheduled = onSchedule(
  {
    region: FUNCTIONS_REGION,
    schedule: "0 2 * * *",
    timeZone: "Asia/Manila",
  },
  async () => {
    try {
      await rebuildAdminDashboardMetricsRun();
    } catch (error) {
      console.error("[rebuildAdminDashboardMetrics] failed", error);
      throw error;
    }
  },
);

async function commitWrites(db, writes) {
  for (let index = 0; index < writes.length; index += 450) {
    const batch = db.batch();
    for (const write of writes.slice(index, index + 450)) {
      if (write.delete) {
        batch.delete(write.ref);
      } else {
        batch.set(write.ref, write.data);
      }
    }
    await batch.commit();
  }
}

function emptyRevenueMonth(monthKey) {
  return {
    bookingCount: 0,
    grossPaymentVolume: 0,
    label: monthLabel(monthKey),
    monthKey,
    netLendRevenue: 0,
    rentalGmv: 0,
  };
}

function categoryKey(value) {
  const normalized = String(value || "Uncategorized")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  return normalized || "uncategorized";
}

module.exports = {
  adminRebuildDashboardMetrics,
  rebuildAdminDashboardMetricsRun,
  rebuildAdminDashboardMetricsScheduled,
  _test: {
    emptyRevenueMonth,
  },
};
