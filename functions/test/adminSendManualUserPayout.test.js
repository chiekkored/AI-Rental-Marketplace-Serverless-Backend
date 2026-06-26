const assert = require("node:assert/strict");
const test = require("node:test");

const { _test } = require("../calls/payment/adminSendManualUserPayout");

test("manual payout destination auto prefers deposit return destination", () => {
  const depositReturnDestination = { bankId: "bank-1" };
  const payoutDestination = { bankId: "bank-2" };

  const result = _test.resolveManualPayoutDestination({
    destinationKind: "auto",
    paymentProfile: { depositReturnDestination, payoutDestination },
  });

  assert.equal(result.destination, depositReturnDestination);
  assert.equal(result.resolvedDestinationKind, "deposit_return");
});

test("manual payout destination auto falls back to payout destination", () => {
  const payoutDestination = { bankId: "bank-2" };

  const result = _test.resolveManualPayoutDestination({
    destinationKind: "auto",
    paymentProfile: { payoutDestination },
  });

  assert.equal(result.destination, payoutDestination);
  assert.equal(result.resolvedDestinationKind, "payout_destination");
});

test("manual payout idempotency key accepts generated web keys", () => {
  assert.equal(_test.normalizeIdempotencyKey("123456789012"), "123456789012");
  assert.equal(
    _test.normalizeIdempotencyKey("a33b20408705406ca28e96ed12cba28c"),
    "a33b20408705406ca28e96ed12cba28c",
  );
});

test("manual payout destination summary hides full account number", () => {
  const summary = _test.summarizeDestination({
    accountNumber: "1234567890",
    bankCode: "BANK",
    bankId: "bank-1",
    bankName: "Bank",
    destinationType: "bank",
    provider: "instapay",
  });

  assert.equal(summary.accountLast4, "7890");
  assert.equal(summary.accountNumber, undefined);
});
