const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { getDiditConfig, verifySignatureSimple, verifySignatureV2 } = require("../utils/didit.util");

exports.diditVerificationWebhook = async (request, response) => {
  if (request.method !== "POST") {
    response.status(405).json({ message: "Method not allowed" });
    return;
  }

  const config = getDiditConfig();
  const signatureV2 = request.get("X-Signature-V2");
  const signatureSimple = request.get("X-Signature-Simple");
  const timestamp = request.get("X-Timestamp");
  const body = request.body || {};

  if (!config.webhookSecretKey || !timestamp) {
    response.status(401).json({ message: "Missing webhook configuration or timestamp" });
    return;
  }

  const verified =
    (signatureV2 && verifySignatureV2(body, signatureV2, timestamp, config.webhookSecretKey)) ||
    (signatureSimple && verifySignatureSimple(body, signatureSimple, timestamp, config.webhookSecretKey));

  if (!verified) {
    response.status(401).json({ message: "Invalid signature" });
    return;
  }

  const {
    event_id: eventId,
    webhook_type: webhookType,
    session_id: sessionId,
    status,
    vendor_data: userId,
    workflow_id: workflowId,
    decision,
  } = body;

  if (!sessionId) {
    response.status(400).json({ message: "Missing session_id" });
    return;
  }

  const db = admin.firestore();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const sessionRef = db.collection("diditVerificationSessions").doc(sessionId);

  await sessionRef.set(
    {
      sessionId,
      userId: userId || null,
      workflowId: workflowId || null,
      status: status || null,
      decision: decision || null,
      webhookType: webhookType || null,
      lastWebhookEventId: eventId || null,
      rawWebhook: body,
      updatedAt: now,
    },
    { merge: true },
  );

  if (userId) {
    const submissionsSnap = await db
      .collection("verificationSubmissions")
      .where("userId", "==", userId)
      .where("diditSessionId", "==", sessionId)
      .limit(5)
      .get();

    const batch = db.batch();
    submissionsSnap.docs.forEach((doc) => {
      batch.update(doc.ref, {
        diditStatus: status || null,
        faceKycStatus: status || null,
        diditDecision: decision || null,
        diditWorkflowId: workflowId || null,
        diditCompletedAt: now,
        status: "Pending",
      });
    });
    if (!submissionsSnap.empty) {
      await batch.commit();
    }
  }

  functions.logger.info("Didit webhook processed", {
    sessionId,
    userId,
    status,
    webhookType,
  });

  response.json({ message: "Webhook event processed" });
};
