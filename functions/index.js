require("dotenv").config({ quiet: true });

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { makeToken } = require("./calls/makeToken.js");
const { verifyAndMark } = require("./calls/verifyAndMark.js");
const { regenerateToken } = require("./calls/regenerateToken.js");
const { verifyToken } = require("./calls/verifyToken.js");
const { confirmBooking } = require("./calls/confirmBooking.js");
const { createBookingRequest } = require("./calls/createBookingRequest.js");
const { createBookingPaymentSession } = require("./calls/payment/createBookingPaymentSession.js");
const { syncBookingPaymentSession } = require("./calls/payment/syncBookingPaymentSession.js");
const { recoverBookingPaymentSession } = require("./calls/payment/recoverBookingPaymentSession.js");
const { cancelBookingPaymentSession } = require("./calls/payment/cancelBookingPaymentSession.js");
const { paymongoPaymentWebhook } = require("./calls/payment/paymongoPaymentWebhook.js");
const { listPaymentSavedMethods } = require("./calls/payment/listPaymentSavedMethods.js");
const { attachSavedPaymentMethodToSession } = require("./calls/payment/attachSavedPaymentMethodToSession.js");
const { setPaymentDestination } = require("./calls/payment/setPaymentDestination.js");
const { getPaymentDestinations } = require("./calls/payment/getPaymentDestinations.js");
const { listPaymentDestinationInstitutions } = require("./calls/payment/listPaymentDestinationInstitutions.js");
const { completeReturnedBooking } = require("./calls/payment/completeReturnedBooking.js");
const { requestDepositDeduction } = require("./calls/payment/requestDepositDeduction.js");
const { acceptDepositDeduction } = require("./calls/payment/acceptDepositDeduction.js");
const { disputeDepositDeduction } = require("./calls/payment/disputeDepositDeduction.js");
const { adminCreateDisputeSupportChat } = require("./calls/payment/adminCreateDisputeSupportChat.js");
const { adminSendDisputeSupportMessage } = require("./calls/payment/adminSendDisputeSupportMessage.js");
const { adminUpdateDisputeSupportRequest } = require("./calls/payment/adminUpdateDisputeSupportRequest.js");
const { adminSettleDepositDispute } = require("./calls/payment/adminSettleDepositDispute.js");
const { adminRequestOutstandingDamagePayment } = require("./calls/payment/adminRequestOutstandingDamagePayment.js");
const { createOutstandingDamagePaymentSession } = require("./calls/payment/createOutstandingDamagePaymentSession.js");
const {
  adminReleaseOutstandingDamageSettlement,
} = require("./calls/payment/adminReleaseOutstandingDamageSettlement.js");
const { adminSendManualUserPayout } = require("./calls/payment/adminSendManualUserPayout.js");
const { declineOverlappingBookings } = require("./calls/declineOverlappingBookings.js");
const { submitBookingReview } = require("./calls/submitBookingReview.js");
const {
  adminUpdateBookingStatus,
  cancelBooking,
  requestBookingCancellation,
  reviewBookingCancellation,
} = require("./calls/cancelBooking.js");
const { manageUserSupportChat } = require("./calls/manageUserSupportChat.js");
const { adminDeleteListing } = require("./calls/adminDeleteListing.js");
const { adminUpdateListingStatus } = require("./calls/adminUpdateListingStatus.js");
const { createAdminUser } = require("./calls/createAdminUser.js");
const { deleteAdminUser } = require("./calls/deleteAdminUser.js");
const { updateAdminUser } = require("./calls/updateAdminUser.js");
const {
  deleteUserAccount,
  deactivateAccount,
  disableUser,
  getAccountDeactivationEligibility,
  getAccountDeletionEligibility,
  reactivateAccount,
} = require("./calls/account");
const { diditVerificationWebhook } = require("./calls/diditVerificationWebhook.js");
const { recordRecommendationEvent } = require("./calls/recordRecommendationEvent.js");
const {
  createListingShareLink,
  resolveListingShareLink,
  resolveListingShareLinkWeb,
} = require("./calls/listingShareLinks.js");
const { getHomeRecommendations } = require("./calls/getHomeRecommendations.js");
const { getHomeRecommended } = require("./calls/getHomeRecommended.js");
const { getHomePopular } = require("./calls/getHomePopular.js");
const { getPricingPolicy, updatePricingPolicy } = require("./calls/pricingPolicy.js");
const {
  listRemoteConfigParameters,
  publishRemoteConfigParameter,
  removeRemoteConfigParameter,
} = require("./calls/remote-config/remoteConfigParameters.js");
const { setMaintenanceMode } = require("./calls/setMaintenanceMode.js");
const {
  submitEarlyAccessSignup,
} = require("./calls/early-access/submitEarlyAccessSignup.js");
const {
  claimOwnerInvite,
  recordOwnerInviteOpen,
  resolveOwnerInvite,
} = require("./calls/owner-invites/ownerInvites.js");
const { requestEmailVerification, verifyEmail } = require("./calls/emailVerification.js");
const { registerFcmToken } = require("./calls/registerFcmToken.js");
const { manageUserBlock } = require("./calls/manageUserBlock.js");
const { unregisterFcmToken } = require("./calls/unregisterFcmToken.js");
const { updateNotificationPreferences } = require("./calls/updateNotificationPreferences.js");
const {
  deleteListingReviewSubmission,
  reviewListingSubmission,
  submitListingForReview,
} = require("./listing-review/submitListingForReview.js");
const { createDummyListings } = require("./calls/createDummyListings.js");
const { requestListingComplianceDocuments } = require("./calls/requestListingComplianceDocuments.js");
const { getBookingDocument } = require("./calls/getBookingDocument.js");
const { reviewBusinessRegistrationSubmission } = require("./calls/business/reviewBusinessRegistrationSubmission.js");
const {
  deleteListing,
  getListingDeletionEligibility,
  requestListingDeactivationReview,
  reviewListingDeactivationRequest,
} = require("./calls/listingDeactivation.js");
const { syncUserMetadata } = require("./scheduled/syncUserMetadata.js");
const {
  reconcilePendingPaymentCheckouts,
} = require("./scheduled/reconcilePendingPaymentCheckouts.js");
const {
  adminRebuildDashboardMetrics,
  rebuildAdminDashboardMetricsScheduled,
} = require("./scheduled/rebuildAdminDashboardMetrics.js");
const { notifyChatMessage } = require("./triggers/notifyChatMessage.js");
const { notifyVerificationReview } = require("./triggers/notifyVerificationReview.js");
const {
  updateDashboardAssets,
  updateDashboardBookings,
  updateDashboardBusinessSubmissions,
  updateDashboardDeactivationRequests,
  updateDashboardListingReviews,
  updateDashboardReports,
  updateDashboardUsers,
} = require("./triggers/updateAdminDashboardMetrics.js");
const { processListingReviewSubmission } = require("./listing-review/processListingReviewSubmission.js");
const { FUNCTIONS_REGION } = require("./utils/functionsRegion.util.js");
const { assertMaintenanceModeDisabled } = require("./utils/maintenanceMode.util.js");
const { setGlobalOptions } = require("firebase-functions/v2");

// Initialize Firebase Admin SDK only once
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

// Export your HTTPS callable or REST functions
const regionOptions = { region: FUNCTIONS_REGION };
setGlobalOptions({
  region: FUNCTIONS_REGION,
});

exports.makeToken = functions.https.onCall(regionOptions, guardMaintenance(makeToken));
exports.verifyAndMark = functions.https.onCall(regionOptions, guardMaintenance(verifyAndMark));
exports.regenerateToken = functions.https.onCall(regionOptions, guardMaintenance(regenerateToken));
exports.verifyToken = functions.https.onCall(regionOptions, guardMaintenance(verifyToken));
exports.confirmBooking = functions.https.onCall(regionOptions, guardMaintenance(confirmBooking));
exports.createBookingRequest = functions.https.onCall(regionOptions, guardMaintenance(createBookingRequest));
exports.createBookingPaymentSession = functions.https.onCall(
  regionOptions,
  guardMaintenance(createBookingPaymentSession),
);
exports.syncBookingPaymentSession = functions.https.onCall(regionOptions, guardMaintenance(syncBookingPaymentSession));
exports.recoverBookingPaymentSession = functions.https.onCall(
  regionOptions,
  guardMaintenance(recoverBookingPaymentSession),
);
exports.cancelBookingPaymentSession = functions.https.onCall(
  regionOptions,
  guardMaintenance(cancelBookingPaymentSession),
);
exports.listPaymentSavedMethods = functions.https.onCall(regionOptions, guardMaintenance(listPaymentSavedMethods));
exports.attachSavedPaymentMethodToSession = functions.https.onCall(
  regionOptions,
  guardMaintenance(attachSavedPaymentMethodToSession),
);
exports.setPaymentDestination = functions.https.onCall(regionOptions, guardMaintenance(setPaymentDestination));
exports.getPaymentDestinations = functions.https.onCall(regionOptions, guardMaintenance(getPaymentDestinations));
exports.listPaymentDestinationInstitutions = functions.https.onCall(
  regionOptions,
  guardMaintenance(listPaymentDestinationInstitutions),
);
exports.completeReturnedBooking = functions.https.onCall(regionOptions, guardMaintenance(completeReturnedBooking));
exports.requestDepositDeduction = functions.https.onCall(regionOptions, guardMaintenance(requestDepositDeduction));
exports.acceptDepositDeduction = functions.https.onCall(regionOptions, guardMaintenance(acceptDepositDeduction));
exports.disputeDepositDeduction = functions.https.onCall(regionOptions, guardMaintenance(disputeDepositDeduction));
exports.adminCreateDisputeSupportChat = functions.https.onCall(regionOptions, adminCreateDisputeSupportChat);
exports.adminSendDisputeSupportMessage = functions.https.onCall(regionOptions, adminSendDisputeSupportMessage);
exports.adminUpdateDisputeSupportRequest = functions.https.onCall(regionOptions, adminUpdateDisputeSupportRequest);
exports.adminSettleDepositDispute = functions.https.onCall(regionOptions, adminSettleDepositDispute);
exports.adminRequestOutstandingDamagePayment = functions.https.onCall(
  regionOptions,
  adminRequestOutstandingDamagePayment,
);
exports.createOutstandingDamagePaymentSession = functions.https.onCall(
  regionOptions,
  createOutstandingDamagePaymentSession,
);
exports.adminReleaseOutstandingDamageSettlement = functions.https.onCall(
  regionOptions,
  adminReleaseOutstandingDamageSettlement,
);
exports.adminSendManualUserPayout = functions.https.onCall(regionOptions, adminSendManualUserPayout);
exports.submitBookingReview = functions.https.onCall(regionOptions, guardMaintenance(submitBookingReview));
exports.cancelBooking = functions.https.onCall(regionOptions, guardMaintenance(cancelBooking));
exports.requestBookingCancellation = functions.https.onCall(
  regionOptions,
  guardMaintenance(requestBookingCancellation),
);
exports.reviewBookingCancellation = functions.https.onCall(regionOptions, reviewBookingCancellation);
exports.adminUpdateBookingStatus = functions.https.onCall(regionOptions, adminUpdateBookingStatus);
exports.manageUserSupportChat = functions.https.onCall(regionOptions, manageUserSupportChat);
exports.adminDeleteListing = functions.https.onCall(regionOptions, adminDeleteListing);
exports.adminUpdateListingStatus = functions.https.onCall(regionOptions, adminUpdateListingStatus);
exports.createAdminUser = functions.https.onCall(regionOptions, createAdminUser);
exports.deleteAdminUser = functions.https.onCall(regionOptions, deleteAdminUser);
exports.deleteUser = functions.https.onCall(regionOptions, guardMaintenance(deleteUserAccount));
exports.updateAdminUser = functions.https.onCall(regionOptions, updateAdminUser);
exports.disableUser = functions.https.onCall(regionOptions, disableUser);
exports.getAccountDeactivationEligibility = functions.https.onCall(
  regionOptions,
  guardMaintenance(getAccountDeactivationEligibility),
);
exports.getAccountDeletionEligibility = functions.https.onCall(
  regionOptions,
  guardMaintenance(getAccountDeletionEligibility),
);
exports.deactivateAccount = functions.https.onCall(regionOptions, guardMaintenance(deactivateAccount));
exports.reactivateAccount = functions.https.onCall(regionOptions, guardMaintenance(reactivateAccount));
exports.getHomeRecommendations = functions.https.onCall(regionOptions, guardMaintenance(getHomeRecommendations));
exports.getHomeRecommended = functions.https.onCall(regionOptions, guardMaintenance(getHomeRecommended));
exports.getHomePopular = functions.https.onCall(regionOptions, guardMaintenance(getHomePopular));
exports.recordRecommendationEvent = functions.https.onCall(regionOptions, guardMaintenance(recordRecommendationEvent));
exports.createListingShareLink = functions.https.onCall(regionOptions, guardMaintenance(createListingShareLink));
exports.resolveListingShareLink = functions.https.onCall(regionOptions, guardMaintenance(resolveListingShareLink));
exports.getPricingPolicy = functions.https.onCall(regionOptions, getPricingPolicy);
exports.updatePricingPolicy = functions.https.onCall(regionOptions, updatePricingPolicy);
exports.listRemoteConfigParameters = functions.https.onCall(regionOptions, listRemoteConfigParameters);
exports.publishRemoteConfigParameter = functions.https.onCall(regionOptions, publishRemoteConfigParameter);
exports.removeRemoteConfigParameter = functions.https.onCall(regionOptions, removeRemoteConfigParameter);
exports.setMaintenanceMode = functions.https.onCall(regionOptions, setMaintenanceMode);
exports.submitEarlyAccessSignup = functions.https.onCall(
  regionOptions,
  guardMaintenance(submitEarlyAccessSignup),
);
exports.resolveOwnerInvite = functions.https.onCall(
  regionOptions,
  guardMaintenance(resolveOwnerInvite),
);
exports.recordOwnerInviteOpen = functions.https.onCall(
  regionOptions,
  guardMaintenance(recordOwnerInviteOpen),
);
exports.claimOwnerInvite = functions.https.onCall(
  regionOptions,
  guardMaintenance(claimOwnerInvite),
);
exports.requestEmailVerification = functions.https.onCall(
  regionOptions,
  guardMaintenance(requestEmailVerification),
);
exports.verifyEmail = functions.https.onRequest(regionOptions, verifyEmail);
exports.registerFcmToken = functions.https.onCall(regionOptions, guardMaintenance(registerFcmToken));
exports.unregisterFcmToken = functions.https.onCall(regionOptions, guardMaintenance(unregisterFcmToken));
exports.updateNotificationPreferences = functions.https.onCall(regionOptions, guardMaintenance(updateNotificationPreferences));
exports.manageUserBlock = functions.https.onCall(regionOptions, guardMaintenance(manageUserBlock));
exports.submitListingForReview = functions.https.onCall(regionOptions, guardMaintenance(submitListingForReview));
exports.createDummyListings = functions.https.onCall(regionOptions, guardMaintenance(createDummyListings));
exports.reviewListingSubmission = functions.https.onCall(regionOptions, reviewListingSubmission);
exports.deleteListingReviewSubmission = functions.https.onCall(regionOptions, deleteListingReviewSubmission);
exports.requestListingComplianceDocuments = functions.https.onCall(regionOptions, requestListingComplianceDocuments);
exports.getBookingDocument = functions.https.onCall(regionOptions, guardMaintenance(getBookingDocument));
exports.reviewBusinessRegistrationSubmission = functions.https.onCall(
  regionOptions,
  reviewBusinessRegistrationSubmission,
);
exports.getListingDeletionEligibility = functions.https.onCall(
  regionOptions,
  guardMaintenance(getListingDeletionEligibility),
);
exports.deleteListing = functions.https.onCall(regionOptions, guardMaintenance(deleteListing));
exports.requestListingDeactivationReview = functions.https.onCall(
  regionOptions,
  guardMaintenance(requestListingDeactivationReview),
);
exports.reviewListingDeactivationRequest = functions.https.onCall(regionOptions, reviewListingDeactivationRequest);
exports.adminRebuildDashboardMetrics = functions.https.onCall(
  regionOptions,
  adminRebuildDashboardMetrics,
);
exports.diditVerificationWebhook = functions.https.onRequest(regionOptions, diditVerificationWebhook);
exports.paymongoPaymentWebhook = functions.https.onRequest(regionOptions, paymongoPaymentWebhook);
exports.resolveListingShareLinkWeb = functions.https.onRequest(regionOptions, resolveListingShareLinkWeb);
if (process.env.FUNCTIONS_EMULATOR === "true") {
  const { bootstrapAdminUser } = require("./calls/bootstrapAdminUser.js");
  exports.bootstrapAdminUser = bootstrapAdminUser;
}

// Export HTTP-triggered function (for Cloud Tasks)
exports.declineOverlappingBookings = declineOverlappingBookings;

// Export scheduled functions
// exports.syncUserMetadata = syncUserMetadata;
exports.reconcilePendingPaymentCheckouts = reconcilePendingPaymentCheckouts;
exports.rebuildAdminDashboardMetricsScheduled = rebuildAdminDashboardMetricsScheduled;

// Export Firestore triggers
exports.notifyChatMessage = notifyChatMessage;
exports.notifyVerificationReview = notifyVerificationReview;
exports.processListingReviewSubmission = processListingReviewSubmission;
exports.updateDashboardAssets = updateDashboardAssets;
exports.updateDashboardBookings = updateDashboardBookings;
exports.updateDashboardBusinessSubmissions = updateDashboardBusinessSubmissions;
exports.updateDashboardDeactivationRequests = updateDashboardDeactivationRequests;
exports.updateDashboardListingReviews = updateDashboardListingReviews;
exports.updateDashboardReports = updateDashboardReports;
exports.updateDashboardUsers = updateDashboardUsers;

function guardMaintenance(handler) {
  return async (request) => {
    await assertMaintenanceModeDisabled(request);
    return handler(request);
  };
}
