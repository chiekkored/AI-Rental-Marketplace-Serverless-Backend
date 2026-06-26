const functions = require("firebase-functions");
const admin = require("firebase-admin");

/**
 * Scheduled Cloud Function to sync denormalized user metadata across all collections.
 * Runs daily at 2 AM UTC to batch-update documents containing stale user metadata.
 *
 * This implements the lazy-fetch consistency pattern:
 * - User profiles can lag by up to 24 hours (eventual consistency)
 * - Mobile app checks version on display and fetches fresh if stale (strong consistency on-demand)
 * - This function ensures all stale copies are eventually updated
 */
// exports.syncUserMetadata = functions.pubsub
//   .schedule("0 2 * * *") // 2 AM UTC daily
//   .timeZone("UTC")
//   .onRun(async (context) => {
//     try {
//       const db = admin.firestore();
//       let syncedCount = 0;
//       let errorCount = 0;

//       // Get all users in the database
//       const usersSnap = await db.collection("users").get();

//       for (const userDoc of usersSnap.docs) {
//         const userId = userDoc.id;
//         const userData = userDoc.data();
//         const currentVersion = userData.userMetadataVersion || 1;

//         try {
//           // Create SimpleUser object with current data
//           const simpleUserData = {
//             uid: userId,
//             firstName: userData.firstName,
//             lastName: userData.lastName,
//             photoUrl: userData.photoUrl,
//             userMetadataVersion: currentVersion,
//           };

//           // Update user's bookings (as renter)
//           const renterBookingsSnap = await db
//             .collection("users")
//             .doc(userId)
//             .collection("bookings")
//             .where("renter.userMetadataVersion", "<", currentVersion)
//             .get();

//           const batch1 = db.batch();
//           renterBookingsSnap.forEach((doc) => {
//             batch1.update(doc.ref, { renter: simpleUserData });
//             syncedCount++;
//           });
//           if (renterBookingsSnap.size > 0) {
//             await batch1.commit();
//           }

//           // Find all asset bookings where this user is the renter
//           const assetBookingsSnap = await db
//             .collectionGroup("bookings")
//             .where("renter.uid", "==", userId)
//             .where("renter.userMetadataVersion", "<", currentVersion)
//             .get();

//           const batch2 = db.batch();
//           assetBookingsSnap.forEach((doc) => {
//             batch2.update(doc.ref, { renter: simpleUserData });
//             syncedCount++;
//           });
//           if (assetBookingsSnap.size > 0) {
//             await batch2.commit();
//           }

//           // Update chat metadata where user is a participant
//           const userChatsSnap = await db.collection("userChats").doc(userId).collection("chats").get();

//           const batch3 = db.batch();
//           let chatUpdateCount = 0;

//           for (const chatDoc of userChatsSnap.docs) {
//             const chatData = chatDoc.data();
//             const participants = chatData.participants || [];

//             // Check if any participant has stale user version
//             const needsUpdate = participants.some((p) => p.uid === userId && p.userMetadataVersion < currentVersion);

//             if (needsUpdate) {
//               // Update participants array with fresh user data
//               const updatedParticipants = participants.map((p) => (p.uid === userId ? simpleUserData : p));
//               batch3.update(chatDoc.ref, { participants: updatedParticipants });
//               chatUpdateCount++;
//               syncedCount++;
//             }
//           }
//           if (chatUpdateCount > 0) {
//             await batch3.commit();
//           }

//           console.log(`Synced user ${userId}: updated ${chatUpdateCount} chats`);
//         } catch (userError) {
//           console.error(`Error syncing user ${userId}:`, userError);
//           errorCount++;
//         }
//       }

//       console.log(`Metadata sync complete: ${syncedCount} denormalized documents updated, ${errorCount} errors`);

//       return {
//         success: true,
//         syncedCount,
//         errorCount,
//         timestamp: new Date().toISOString(),
//       };
//     } catch (error) {
//       console.error("syncUserMetadata error:", error);
//       throw error;
//     }
//   });
