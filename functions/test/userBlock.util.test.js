const assert = require("node:assert/strict");
const test = require("node:test");

const {
  shouldPreserveBlockedChat,
  userBlockId,
} = require("../utils/userBlock.util");
const { _test } = require("../calls/manageUserBlock");

test("userBlockId is directional", () => {
  assert.equal(userBlockId("a", "b"), "1:ab");
  assert.notEqual(userBlockId("a", "b"), userBlockId("b", "a"));
  assert.notEqual(userBlockId("a_b", "c"), userBlockId("a", "b_c"));
});

test("blocked chats are preserved only while booking coordination is required", () => {
  for (const bookingStatus of [
    "Pending",
    "Confirmed",
    "HandedOver",
    "Returned",
    "Cancellation Requested",
  ]) {
    assert.equal(shouldPreserveBlockedChat({ bookingStatus }), true);
  }
  assert.equal(shouldPreserveBlockedChat({ bookingStatus: "Completed" }), false);
  assert.equal(shouldPreserveBlockedChat({ bookingStatus: "Cancelled" }), false);
  assert.equal(shouldPreserveBlockedChat({ bookingId: "legacy-booking" }), true);
  assert.equal(shouldPreserveBlockedChat({}), false);
});

test("block targets cannot be self or empty", () => {
  assert.throws(() => _test.assertValidTarget("a", ""));
  assert.throws(() => _test.assertValidTarget("a", "a"));
  assert.doesNotThrow(() => _test.assertValidTarget("a", "b"));
});

test("block cleanup writes are committed in bounded chunks", async () => {
  const committedBatchSizes = [];
  const db = {
    batch() {
      const writes = [];
      return {
        delete(ref) {
          writes.push(ref);
        },
        async commit() {
          committedBatchSizes.push(writes.length);
        },
      };
    },
  };
  const writes = Array.from(
    { length: 801 },
    (_, index) => (batch) => batch.delete(`document-${index}`),
  );

  await _test.commitWritesInChunks(db, writes);

  assert.deepEqual(committedBatchSizes, [400, 400, 1]);
});
