const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { verifySignatureSimple, verifySignatureV2 } = require("../utils/didit.util");

test("verifySignatureSimple accepts a valid Didit fallback signature", () => {
  const body = {
    timestamp: 1774970000,
    session_id: "session-1",
    status: "Approved",
    webhook_type: "status.updated",
  };
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = "test-secret";
  const canonical = "1774970000:session-1:Approved:status.updated";
  const signature = crypto.createHmac("sha256", secret).update(canonical).digest("hex");

  assert.equal(verifySignatureSimple(body, signature, timestamp, secret), true);
  assert.equal(verifySignatureSimple(body, "bad-signature", timestamp, secret), false);
});

test("verifySignatureV2 accepts sorted JSON and rejects stale timestamps", () => {
  const body = {
    webhook_type: "status.updated",
    status: "In Review",
    session_id: "session-1",
    timestamp: 1774970000,
  };
  const timestamp = String(Math.floor(Date.now() / 1000));
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);
  const secret = "test-secret";
  const canonical = JSON.stringify({
    session_id: "session-1",
    status: "In Review",
    timestamp: 1774970000,
    webhook_type: "status.updated",
  });
  const signature = crypto.createHmac("sha256", secret).update(canonical, "utf8").digest("hex");

  assert.equal(verifySignatureV2(body, signature, timestamp, secret), true);
  assert.equal(verifySignatureV2(body, signature, staleTimestamp, secret), false);
});
