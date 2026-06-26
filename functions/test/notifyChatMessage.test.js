const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _test: { canNotifyChatRecipient, chatNotificationImageUrl, formatChatNotificationTitle },
} = require("../triggers/notifyChatMessage");

test("chat notification title uses booking start date and sender name", () => {
  const title = formatChatNotificationTitle(
    {
      bookingStartDate: new Date(Date.UTC(2026, 3, 10)),
      participants: [
        { uid: "sender-1", firstName: "Alex", lastName: "Rivera" },
        { uid: "recipient-1", firstName: "Sam", lastName: "Lee" },
      ],
    },
    "sender-1",
  );

  assert.equal(title, "Apr 10 · Alex Rivera");
});

test("chat notification title falls back when booking date is missing", () => {
  assert.equal(
    formatChatNotificationTitle(
      {
        participants: [{ uid: "sender-1", firstName: "Alex" }],
      },
      "sender-1",
    ),
    "New message Alex",
  );
});

test("system chat notification title uses booking subject", () => {
  assert.equal(
    formatChatNotificationTitle(
      {
        asset: { title: "Camera" },
        bookingStartDate: new Date(Date.UTC(2026, 3, 10)),
      },
      "",
      { type: "system" },
    ),
    "Camera for Apr 10, 2026",
  );
});

test("chat notification recipient respects message visibleTo", () => {
  assert.equal(canNotifyChatRecipient({ visibleTo: ["renter-1"] }, "renter-1"), true);
  assert.equal(canNotifyChatRecipient({ visibleTo: ["renter-1"] }, "owner-1"), false);
  assert.equal(canNotifyChatRecipient({}, "owner-1"), true);
});

test("chat notification image uses sender photo with listing fallback", () => {
  const chat = {
    asset: { images: ["https://cdn.example.com/listing.jpg"] },
    participants: [
      { uid: "sender-1", photoUrl: " https://cdn.example.com/sender.jpg " },
      { uid: "recipient-1" },
    ],
  };

  assert.equal(
    chatNotificationImageUrl(chat, "sender-1", { type: "text" }),
    "https://cdn.example.com/sender.jpg",
  );
  assert.equal(
    chatNotificationImageUrl(chat, "sender-2", { type: "text" }),
    "https://cdn.example.com/listing.jpg",
  );
  assert.equal(
    chatNotificationImageUrl(chat, "sender-1", { type: "system" }),
    "https://cdn.example.com/listing.jpg",
  );
});
