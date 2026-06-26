const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { formatBookingSubject } = require("../utils/booking.util");
const { firstListingImageUrl, sendNotificationToUser } = require("../utils/notification.util");
const { FUNCTIONS_REGION } = require("../utils/functionsRegion.util");

function formatChatNotificationTitle(chat, senderId, message = {}) {
  if (message?.type === "system" || !senderId) {
    return formatBookingSubject(chat, "Booking update");
  }

  const sender = chat?.participants?.find((participant) => participant?.uid === senderId);
  const senderName =
    (typeof sender?.displayName === "string" && sender.displayName.trim()) ||
    [sender?.firstName, sender?.lastName].filter(Boolean).join(" ").trim() ||
    "Lend user";
  const startDate = parseFirestoreDate(chat?.bookingStartDate);
  if (!startDate) return `New message ${senderName}`;
  return `${formatShortDate(startDate)} · ${senderName}`;
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function parseFirestoreDate(value) {
  if (!value) return null;
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isMediaUrl(value = "") {
  const trimmed = String(value).trim();

  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.toLowerCase();

    return /\.(jpg|jpeg|png|gif|webp|bmp|svg|mp4|mov|avi|mkv|webm|mp3|wav|m4a|aac|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar)$/i.test(
      pathname,
    );
  } catch (_) {
    return false;
  }
}

function isUrl(value = "") {
  const trimmed = String(value).trim();

  try {
    new URL(trimmed);
    return /^https?:\/\//i.test(trimmed);
  } catch (_) {
    return false;
  }
}

function formatChatNotificationBody(text = "") {
  const trimmed = String(text).trim();

  if (isMediaUrl(trimmed)) {
    return "Sent a media";
  }

  if (isUrl(trimmed)) {
    return "Sent a url";
  }

  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function canNotifyChatRecipient(message, recipientId) {
  if (!recipientId) return false;
  const visibleTo = Array.isArray(message?.visibleTo) ? message.visibleTo.filter(Boolean) : [];
  return visibleTo.length === 0 || visibleTo.includes(recipientId);
}

function chatNotificationImageUrl(chat, senderId, message = {}) {
  if (message?.type !== "system" && senderId) {
    const sender = chat?.participants?.find((participant) => participant?.uid === senderId);
    if (typeof sender?.photoUrl === "string" && sender.photoUrl.trim()) {
      return sender.photoUrl.trim();
    }
  }

  return firstListingImageUrl(chat?.asset);
}

exports.notifyChatMessage = onDocumentCreated(
  {
    document: "chats/{chatId}/messages/{messageId}",
    region: FUNCTIONS_REGION,
  },
  async (event) => {
    const message = event.data?.data();
    const chatId = event.params.chatId;
    const senderId = message?.senderId || "";
    const text = message?.text;

    if (!text) return null;

    const chatMirrors = await admin.firestore().collectionGroup("chats").where("chatId", "==", chatId).get();

    const sends = [];
    const seenRecipients = new Set();

    chatMirrors.docs.forEach((doc) => {
      const userChatsRoot = doc.ref.parent.parent;
      const recipientId = userChatsRoot?.id;
      if (
        !recipientId ||
        (senderId && recipientId === senderId) ||
        seenRecipients.has(recipientId) ||
        !canNotifyChatRecipient(message, recipientId)
      ) {
        return;
      }

      seenRecipients.add(recipientId);
      const chat = doc.data();
      const assetTitle = chat?.asset?.title || "Lend";

      sends.push(
        sendNotificationToUser({
          uid: recipientId,
          title: formatChatNotificationTitle(chat, senderId, message),
          body: formatChatNotificationBody(text),
          imageUrl: chatNotificationImageUrl(chat, senderId, message),
          persist: false,
          data: {
            type: "chat",
            chatId,
            bookingId: chat?.bookingId,
            assetId: chat?.asset?.id,
            senderId,
            title: assetTitle,
          },
        }),
      );
    });

    await Promise.allSettled(sends);
    return null;
  },
);

exports._test = {
  canNotifyChatRecipient,
  chatNotificationImageUrl,
  formatChatNotificationTitle,
};
