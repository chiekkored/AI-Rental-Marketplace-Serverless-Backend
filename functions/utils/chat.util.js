const admin = require("firebase-admin");

exports.sendSystemChatMessage = async ({
  chatId,
  ownerId,
  renterId,
  messageText,
  messageType,
  messageId,
  includeLastMessage = true,
  includeOwner = true,
  includeRenter = true,
}) => {
  const firestore = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;

  const messagesCollection = firestore.collection("chats").doc(chatId).collection("messages");
  const chatsRef = messageId ? messagesCollection.doc(messageId) : messagesCollection.doc();

  const ownerUserChatRef = firestore.collection("userChats").doc(ownerId).collection("chats").doc(chatId);

  const renterUserChatRef = firestore.collection("userChats").doc(renterId).collection("chats").doc(chatId);

  const messageData = {
    id: chatsRef.id,
    text: messageText,
    senderId: "", // System message
    createdAt: FieldValue?.serverTimestamp() || new Date(),
    type: messageType,
    visibleTo: [renterId, ownerId],
  };

  const chatUpdateData = {
    hasRead: false,
    ...(includeLastMessage
      ? {
          lastMessage: messageText,
          lastMessageDate: FieldValue?.serverTimestamp() || new Date(),
          lastMessageSenderId: "",
        }
      : {}),
  };

  await firestore.runTransaction(async (transaction) => {
    const existingMessage = messageId ? await transaction.get(chatsRef) : null;

    if (!existingMessage?.exists) {
      transaction.set(chatsRef, messageData);
    }

    if (includeOwner) transaction.update(ownerUserChatRef, chatUpdateData);
    if (includeRenter) transaction.update(renterUserChatRef, chatUpdateData);
  });
};
