const {
  RECURRING_BILLING_CHUNK_STATUS,
  RECURRING_BILLING_CHUNK_TYPES,
  RECURRING_BILLING_STATUS,
} = require("./recurringBilling.constants");

function buildRentalBillingChunks({ rates, bookingRange }) {
  if (!rates || typeof rates !== "object") {
    throw new Error("Asset rates are missing");
  }

  const chunks = [];
  let currentDate = new Date(
    bookingRange.startDate.getFullYear(),
    bookingRange.startDate.getMonth(),
    bookingRange.startDate.getDate(),
  );
  const endDate = new Date(
    bookingRange.endDate.getFullYear(),
    bookingRange.endDate.getMonth(),
    bookingRange.endDate.getDate(),
  );

  while (currentDate < endDate) {
    const chunkStart = new Date(currentDate);

    if (Number.isInteger(rates.annually)) {
      const nextYear = new Date(currentDate.getFullYear() + 1, currentDate.getMonth(), currentDate.getDate());
      if (nextYear <= endDate) {
        chunks.push(buildChunk(RECURRING_BILLING_CHUNK_TYPES.annual, rates.annually, chunkStart, nextYear));
        currentDate = nextYear;
        continue;
      }
    }

    if (Number.isInteger(rates.monthly)) {
      const nextMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, currentDate.getDate());
      if (nextMonth <= endDate) {
        chunks.push(buildChunk(RECURRING_BILLING_CHUNK_TYPES.monthly, rates.monthly, chunkStart, nextMonth));
        currentDate = nextMonth;
        continue;
      }
    }

    if (Number.isInteger(rates.weekly)) {
      const nextWeek = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate() + 7);
      if (nextWeek <= endDate) {
        chunks.push(buildChunk(RECURRING_BILLING_CHUNK_TYPES.weekly, rates.weekly, chunkStart, nextWeek));
        currentDate = nextWeek;
        continue;
      }
    }

    if (!Number.isInteger(rates.daily) || rates.daily <= 0) {
      throw new Error("Daily rate is required to calculate booking price");
    }
    const nextDay = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate() + 1);
    chunks.push(buildChunk(RECURRING_BILLING_CHUNK_TYPES.daily, rates.daily, chunkStart, nextDay));
    currentDate = nextDay;
  }

  if (!chunks.length) {
    throw new Error("Unable to calculate booking price");
  }

  return chunks;
}

function buildRecurringBillingPlan({ rates, bookingRange, priceBreakdown, securityDeposit }) {
  const chunks = buildRentalBillingChunks({ rates, bookingRange });
  const subscriptionSchedules = buildSubscriptionSchedules(chunks);
  const dailyRemainderAmount = chunks
    .filter((chunk) => chunk.type === RECURRING_BILLING_CHUNK_TYPES.daily)
    .reduce((sum, chunk) => sum + chunk.amount, 0);
  const upfrontRecurringAmount = chunks
    .filter((chunk, index) => subscriptionSchedules.upfrontChunkIndexes.has(index))
    .reduce((sum, chunk) => sum + chunk.amount, 0);
  const recurringChunks = chunks.filter((chunk) => chunk.type !== RECURRING_BILLING_CHUNK_TYPES.daily);
  const recurringSubtotal = recurringChunks.reduce((sum, chunk) => sum + chunk.amount, 0);
  const scheduledRecurringAmount = subscriptionSchedules.schedules.reduce((sum, schedule) => sum + schedule.amount * schedule.cycleCount, 0);
  const securityDepositAmount = securityDeposit?.enabled ? Number(securityDeposit.amount || 0) : 0;
  const isRecurring = recurringChunks.length > 0;
  const rentalAmountDueNow = isRecurring ? dailyRemainderAmount + upfrontRecurringAmount : subtotalFromBillingChunks(chunks);

  return {
    isRecurring,
    status:
      isRecurring && subscriptionSchedules.schedules.length > 0
        ? RECURRING_BILLING_STATUS.scheduled
        : RECURRING_BILLING_STATUS.notRequired,
    upfront: {
      rentalDailyRemainderAmount: dailyRemainderAmount,
      firstRecurringAmount: upfrontRecurringAmount,
      rentalAmountDueNow,
      securityDepositAmount,
      renterPlatformFee: Number(priceBreakdown?.renterPlatformFee || 0),
      renterProcessingFee: Number(priceBreakdown?.renterProcessingFee || 0),
      paymentAmount: Number(priceBreakdown?.paymentAmount || 0),
      currency: priceBreakdown?.currency || "PHP",
    },
    recurringSubtotal,
    scheduledRecurringAmount,
    subscriptionSchedules: subscriptionSchedules.schedules,
    chunks: chunks.map((chunk, index) => ({
      ...chunk,
      id: `chunk_${String(index + 1).padStart(3, "0")}`,
      billingMode: subscriptionSchedules.subscriptionChunkIndexes.has(index) ? "subscription" : "upfront",
      status: subscriptionSchedules.subscriptionChunkIndexes.has(index)
        ? RECURRING_BILLING_CHUNK_STATUS.subscriptionPending
        : RECURRING_BILLING_CHUNK_STATUS.includedUpfront,
      subscriptionScheduleId: subscriptionSchedules.chunkScheduleIds.get(index) || null,
      lastPaymentError: null,
    })),
  };
}

function buildSubscriptionSchedules(chunks) {
  const groups = new Map();
  chunks.forEach((chunk, index) => {
    if (chunk.type === RECURRING_BILLING_CHUNK_TYPES.daily) return;
    const key = `${chunk.type}:${chunk.amount}`;
    const group = groups.get(key) || { type: chunk.type, amount: chunk.amount, entries: [] };
    group.entries.push({ chunk, index });
    groups.set(key, group);
  });

  const schedules = [];
  const upfrontChunkIndexes = new Set();
  const subscriptionChunkIndexes = new Set();
  const chunkScheduleIds = new Map();
  const selectedGroup = [...groups.values()].sort((left, right) => {
    return recurringChunkPriority(right.type) - recurringChunkPriority(left.type);
  })[0];

  for (const group of groups.values()) {
    if (group.entries.length === 0) continue;
    if (group !== selectedGroup) {
      group.entries.forEach((entry) => upfrontChunkIndexes.add(entry.index));
      continue;
    }

    upfrontChunkIndexes.add(group.entries[0].index);
    const remaining = group.entries.slice(1);
    if (remaining.length < 2) {
      remaining.forEach((entry) => upfrontChunkIndexes.add(entry.index));
      continue;
    }

    const id = `subscription_${String(schedules.length + 1).padStart(3, "0")}`;
    remaining.forEach((entry) => {
      subscriptionChunkIndexes.add(entry.index);
      chunkScheduleIds.set(entry.index, id);
    });
    const first = remaining[0].chunk;
    const last = remaining[remaining.length - 1].chunk;
    schedules.push({
      id,
      type: group.type,
      amount: group.amount,
      interval: subscriptionIntervalForChunkType(group.type),
      intervalCount: 1,
      cycleCount: remaining.length,
      anchorDate: first.periodStartDate,
      periodStartMs: first.periodStartMs,
      periodEndMs: last.periodEndMs,
      chunkIds: remaining.map((entry) => `chunk_${String(entry.index + 1).padStart(3, "0")}`),
      status: "pending_setup",
      paymongoPlanId: null,
      paymongoSubscriptionId: null,
      setupIntent: null,
      latestInvoice: null,
      nextBillingSchedule: null,
    });
  }

  return { schedules, upfrontChunkIndexes, subscriptionChunkIndexes, chunkScheduleIds };
}

function recurringChunkPriority(type) {
  if (type === RECURRING_BILLING_CHUNK_TYPES.annual) return 3;
  if (type === RECURRING_BILLING_CHUNK_TYPES.monthly) return 2;
  if (type === RECURRING_BILLING_CHUNK_TYPES.weekly) return 1;
  return 0;
}

function subscriptionIntervalForChunkType(type) {
  if (type === RECURRING_BILLING_CHUNK_TYPES.annual) return "yearly";
  if (type === RECURRING_BILLING_CHUNK_TYPES.monthly) return "monthly";
  if (type === RECURRING_BILLING_CHUNK_TYPES.weekly) return "weekly";
  throw new Error(`Unsupported subscription interval: ${type}`);
}

function buildChunk(type, amount, startDate, endDate) {
  return {
    type,
    amount,
    periodStartMs: startDate.getTime(),
    periodEndMs: endDate.getTime(),
    periodStartDate: formatLocalDate(startDate),
    periodEndDate: formatLocalDate(endDate),
  };
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function subtotalFromBillingChunks(chunks) {
  return chunks.reduce((sum, chunk) => sum + chunk.amount, 0);
}

module.exports = {
  buildSubscriptionSchedules,
  buildRecurringBillingPlan,
  buildRentalBillingChunks,
  subscriptionIntervalForChunkType,
  subtotalFromBillingChunks,
};
