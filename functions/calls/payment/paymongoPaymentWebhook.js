const {
  FieldValue,
  admin,
  getPayMongoEventId,
  getPayMongoEventType,
  handlePayMongoEvent,
  verifyWebhookSignature,
} = require("./utils/paymentFlow.util");

async function paymongoPaymentWebhook(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  const rawBody = req.rawBody?.toString("utf8") || JSON.stringify(req.body || {});
  if (!verifyWebhookSignature({ rawBody, headers: req.headers || {} })) {
    res.status(401).send("Invalid signature");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    res.status(400).send("Invalid JSON");
    return;
  }

  const eventId = getPayMongoEventId(payload);
  const eventType = getPayMongoEventType(payload);
  if (!eventId) {
    res.status(200).json({ received: true, ignored: true });
    return;
  }

  const db = admin.firestore();
  const eventRef = db.collection("processedPaymongoEvents").doc(eventId);
  const inserted = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(eventRef);
    if (snap.exists) return false;
    transaction.set(eventRef, {
      id: eventId,
      type: eventType || null,
      receivedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(),
    });
    return true;
  });
  if (!inserted) {
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  try {
    await handlePayMongoEvent(payload);
    await eventRef.set({ processedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(), status: "processed" }, { merge: true });
  } catch (error) {
    console.error(`[paymongoPaymentWebhook] Event ${eventId} failed: ${error.message}`);
    await eventRef.set(
      { processedAt: admin.firestore.FieldValue?.serverTimestamp() || new Date(), status: "failed", error: error.message },
      { merge: true },
    );
  }
  res.status(200).json({ received: true });
}

module.exports = { paymongoPaymentWebhook };
