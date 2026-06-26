const RECURRING_BILLING_CHUNK_TYPES = {
  annual: "annual",
  monthly: "monthly",
  weekly: "weekly",
  daily: "daily",
};

const RECURRING_BILLING_STATUS = {
  notRequired: "not_required",
  scheduled: "scheduled",
  paymentIssue: "payment_issue",
  completed: "completed",
};

const RECURRING_BILLING_CHUNK_STATUS = {
  includedUpfront: "included_upfront",
  subscriptionPending: "subscription_pending",
  subscriptionActive: "subscription_active",
  paid: "paid",
  paymentIssue: "payment_issue",
  cancelled: "cancelled",
};

module.exports = {
  RECURRING_BILLING_CHUNK_TYPES,
  RECURRING_BILLING_CHUNK_STATUS,
  RECURRING_BILLING_STATUS,
};
