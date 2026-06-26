const crypto = require("crypto");

const PAYMONGO_API_BASE_URL = "https://api.paymongo.com";
class PayMongoError extends Error {
  constructor(message, { status, errors, response } = {}) {
    super(message);
    this.name = "PayMongoError";
    this.status = status;
    this.errors = errors || [];
    this.response = response || null;
  }
}

function getPayMongoSecretKey() {
  const key = process.env.PAYMONGO_SECRET_KEY;
  if (!key) {
    throw new PayMongoError("PAYMONGO_SECRET_KEY is not configured");
  }
  return key.trim();
}

function getPayMongoPublicKey() {
  const key = process.env.PAYMONGO_PUBLIC_KEY;
  if (!key) {
    throw new PayMongoError("PAYMONGO_PUBLIC_KEY is not configured");
  }
  return key.trim();
}

function getPayMongoWalletId() {
  return process.env.PAYMONGO_WALLET_ID?.trim() || null;
}

function getPayMongoReturnUrl() {
  return process.env.PAYMONGO_RETURN_URL?.trim() || null;
}

function getPayMongoCheckoutReturnUrl(checkoutId) {
  const baseUrl = getPayMongoReturnUrl();
  try {
    const url = new URL(baseUrl);
    if (checkoutId) {
      url.searchParams.set("checkoutId", checkoutId);
    }
    return url.toString();
  } catch (error) {
    const separator = baseUrl.includes("?") ? "&" : "?";
    return checkoutId ? `${baseUrl}${separator}checkoutId=${encodeURIComponent(checkoutId)}` : baseUrl;
  }
}

function getPayMongoWebhookUrl() {
  return process.env.PAYMONGO_PAYOUT_CALLBACK_URL?.trim() || null;
}

function buildBasicAuth(apiKey) {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

async function paymongoRequest({ method = "GET", path, body, apiKey = getPayMongoSecretKey(), headers = {} }) {
  const response = await fetch(`${PAYMONGO_API_BASE_URL}${path}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: buildBasicAuth(apiKey),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new PayMongoError("PayMongo returned an invalid JSON response", {
      status: response.status,
      response: text,
    });
  }

  if (!response.ok) {
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    const message =
      errors
        .map((error) => error.detail || error.code)
        .filter(Boolean)
        .join("; ") || `PayMongo request failed with status ${response.status}`;
    throw new PayMongoError(message, {
      status: response.status,
      errors,
      response: payload,
    });
  }

  return payload;
}

async function createPaymentIntent({ amount, currency, description, paymentMethods, metadata, setupFutureUsage }) {
  const attributes = buildPaymentIntentAttributes({
    amount: toPayMongoAmount(amount),
    currency,
    description,
    paymentMethods,
    metadata,
    setupFutureUsage,
  });

  return paymongoRequest({
    method: "POST",
    path: "/v1/payment_intents",
    body: { data: { attributes } },
  });
}

function buildPaymentIntentAttributes({ amount, currency, description, paymentMethods, metadata, setupFutureUsage }) {
  const allowedPaymentMethods = Array.isArray(paymentMethods) && paymentMethods.length > 0 ? paymentMethods : ["card"];
  const attributes = {
    amount,
    currency: normalizeCurrency(currency),
    payment_method_allowed: allowedPaymentMethods,
    capture_type: "automatic",
    description,
    metadata,
  };

  if (allowedPaymentMethods.includes("card")) {
    attributes.payment_method_options = {
      card: {
        request_three_d_secure: "any",
      },
    };
  }

  if (setupFutureUsage) {
    attributes.setup_future_usage = setupFutureUsage;
  }

  return attributes;
}

async function retrievePaymentIntent(paymentIntentId) {
  return paymongoRequest({
    method: "GET",
    path: `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`,
  });
}

async function createSubscriptionPlan({
  amount,
  currency,
  cycleCount,
  description,
  interval,
  intervalCount,
  name,
  metadata,
}) {
  const attributes = buildSubscriptionPlanAttributes({
    amount: toPayMongoAmount(amount),
    currency,
    cycleCount,
    description,
    interval,
    intervalCount,
    name,
    metadata,
  });

  return paymongoRequest({
    method: "POST",
    path: "/v1/subscriptions/plans",
    body: { data: { attributes } },
  });
}

function buildSubscriptionPlanAttributes({
  amount,
  currency,
  cycleCount,
  description,
  interval,
  intervalCount,
  name,
  metadata,
}) {
  const attributes = {
    type: "scheduled",
    amount,
    currency: normalizeCurrency(currency),
    cycle_count: cycleCount,
    description,
    interval,
    interval_count: intervalCount || 1,
    name,
  };
  if (metadata) attributes.metadata = metadata;
  return attributes;
}

async function createSubscription({
  anchorDate,
  customerId,
  defaultCustomerPaymentMethodId,
  planId,
  metadata,
  returnUrl,
}) {
  const attributes = buildSubscriptionAttributes({
    anchorDate,
    customerId,
    defaultCustomerPaymentMethodId,
    planId,
    metadata,
    returnUrl,
  });

  return paymongoRequest({
    method: "POST",
    path: "/v1/subscriptions",
    body: { data: { attributes } },
  });
}

function buildSubscriptionAttributes({
  anchorDate,
  customerId,
  defaultCustomerPaymentMethodId,
  planId,
  metadata,
  returnUrl,
}) {
  const attributes = {
    anchor_date: anchorDate,
    customer_id: customerId,
    plan_id: planId,
  };
  if (defaultCustomerPaymentMethodId) {
    attributes.default_customer_payment_method_id = defaultCustomerPaymentMethodId;
  }
  if (metadata) attributes.metadata = metadata;
  if (returnUrl) attributes.return_url = returnUrl;
  return attributes;
}

async function retrieveSubscription(subscriptionId) {
  return paymongoRequest({
    method: "GET",
    path: `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
  });
}

async function cancelSubscription({ subscriptionId, reason = "other" }) {
  return paymongoRequest({
    method: "POST",
    path: `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    body: {
      data: {
        attributes: {
          cancellation_reason: reason,
        },
      },
    },
  });
}

async function createCustomer({ firstName, lastName, email, phone, metadata }) {
  return paymongoRequest({
    method: "POST",
    path: "/v1/customers",
    body: {
      data: {
        attributes: {
          first_name: firstName || "Lend",
          last_name: lastName || "Customer",
          email,
          ...(phone ? { phone } : {}),
          default_device: "phone",
          ...(metadata ? { metadata } : {}),
        },
      },
    },
  });
}

async function listCustomerPaymentMethods(customerId) {
  return paymongoRequest({
    method: "GET",
    path: `/v1/customers/${encodeURIComponent(customerId)}/payment_methods`,
  });
}

async function deleteCustomerPaymentMethod({ customerId, paymentMethodId }) {
  return paymongoRequest({
    method: "DELETE",
    path: `/v1/customers/${encodeURIComponent(customerId)}/payment_methods/${encodeURIComponent(paymentMethodId)}`,
  });
}

async function updatePaymentMethodCvc({ paymentMethodId, cvc }) {
  return paymongoRequest({
    method: "PATCH",
    path: `/v1/payment_methods/${encodeURIComponent(paymentMethodId)}`,
    body: {
      data: {
        attributes: {
          details: {
            card: {
              cvc,
            },
          },
        },
      },
    },
  });
}

async function attachPaymentMethod({ paymentIntentId, paymentMethodId, clientKey, returnUrl }) {
  return paymongoRequest({
    method: "POST",
    path: `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/attach`,
    apiKey: getPayMongoPublicKey(),
    body: {
      data: {
        attributes: {
          payment_method: paymentMethodId,
          client_key: clientKey,
          return_url: returnUrl || getPayMongoReturnUrl(),
        },
      },
    },
  });
}

async function createWalletTransaction({ walletId, amount, currency, description, receiver, provider, callbackUrl }) {
  return paymongoRequest({
    method: "POST",
    path: `/v1/wallets/${encodeURIComponent(walletId)}/transactions`,
    body: {
      data: {
        attributes: {
          amount: toPayMongoAmount(amount),
          currency: normalizeCurrency(currency),
          type: "send_payment",
          provider,
          purpose: "Payout",
          description,
          callback_url: callbackUrl || undefined,
          receiver,
        },
      },
    },
  });
}

function normalizeCurrency(currency) {
  const normalized = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  return normalized || "PHP";
}

async function createRefund({ amount, paymentId, reason = "requested_by_customer", notes, metadata }) {
  return paymongoRequest({
    method: "POST",
    path: "/refunds",
    body: {
      data: {
        attributes: {
          amount: toPayMongoAmount(amount),
          payment_id: paymentId,
          reason,
          ...(notes ? { notes } : {}),
          ...(metadata ? { metadata } : {}),
        },
      },
    },
  });
}

function toPayMongoAmount(amount) {
  const pesoAmount = Number(amount);
  if (!Number.isFinite(pesoAmount) || pesoAmount <= 0) {
    throw new PayMongoError("PayMongo amount must be a positive number");
  }
  return Math.round(pesoAmount * 100);
}

async function listReceivingInstitutions(provider = "instapay") {
  return paymongoRequest({
    method: "GET",
    path: `/v1/wallets/receiving_institutions?provider=${encodeURIComponent(provider)}`,
  });
}

function extractWebhookSignature(headers = {}) {
  return (
    headers["paymongo-signature"] ||
    headers["x-paymongo-signature"] ||
    headers["Paymongo-Signature"] ||
    headers["X-Paymongo-Signature"] ||
    null
  );
}

function verifyWebhookSignature({ rawBody, headers }) {
  const isEmulator = process.env.FUNCTIONS_EMULATOR === "true";
  const secret = process.env.PAYMONGO_WEBHOOK_SECRET?.trim();

  if (!secret) {
    if (isEmulator) return true;
    console.error("[verifyWebhookSignature] PAYMONGO_WEBHOOK_SECRET is not configured");
    return false;
  }

  const signatureHeader = extractWebhookSignature(headers);
  if (!signatureHeader) {
    console.warn("[verifyWebhookSignature] Missing signature header");
    return false;
  }

  const parts = String(signatureHeader).split(",");
  let timestamp = "";
  let receivedSignature = "";

  for (const part of parts) {
    const [key, value] = part.trim().split("=");
    if (key === "t") timestamp = value;
    if (isEmulator && key === "te") receivedSignature = value;
    if (!isEmulator && key === "li") receivedSignature = value;
  }

  if (!timestamp || !receivedSignature) {
    console.warn(
      `[verifyWebhookSignature] Incomplete header: t=${!!timestamp}, sig=${!!receivedSignature} (isEmulator=${isEmulator})`,
    );
    return false;
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSignature = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  const expectedBuffer = Buffer.from(expectedSignature);
  const receivedBuffer = Buffer.from(receivedSignature);

  if (expectedBuffer.length !== receivedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
    console.error("[verifyWebhookSignature] Signature mismatch");
    return false;
  }

  return true;
}

function normalizePayMongoError(error) {
  if (error instanceof PayMongoError) {
    return {
      message: error.message,
      status: error.status || null,
      errors: error.errors || [],
    };
  }

  return {
    message: error?.message || "PayMongo request failed",
    status: null,
    errors: [],
  };
}

module.exports = {
  PayMongoError,
  attachPaymentMethod,
  cancelSubscription,
  createSubscription,
  createSubscriptionPlan,
  createCustomer,
  createPaymentIntent,
  createRefund,
  createWalletTransaction,
  deleteCustomerPaymentMethod,
  getPayMongoCheckoutReturnUrl,
  getPayMongoPublicKey,
  getPayMongoReturnUrl,
  getPayMongoSecretKey,
  getPayMongoWalletId,
  getPayMongoWebhookUrl,
  listCustomerPaymentMethods,
  listReceivingInstitutions,
  normalizePayMongoError,
  retrievePaymentIntent,
  retrieveSubscription,
  toPayMongoAmount,
  updatePaymentMethodCvc,
  verifyWebhookSignature,
  _test: {
    buildPaymentIntentAttributes,
    buildSubscriptionAttributes,
    buildSubscriptionPlanAttributes,
    toPayMongoAmount,
  },
};
