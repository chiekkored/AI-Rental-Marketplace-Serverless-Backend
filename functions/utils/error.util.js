const functions = require('firebase-functions');

/**
 * Throws a Firebase HttpsError and logs its details.
 *
 * @param {string} code - The error code (e.g., "permission-denied", "invalid-argument").
 * @param {string} message - The error message.
 * @param {any} [details] - Optional additional details for the error.
 */
exports.throwAndLogHttpsError = (code, message, details) => {
  functions.logger.error(`HttpsError: Code - ${code}, Message - ${message}, Details - ${JSON.stringify(details)}`);
  throw new functions.https.HttpsError(code, message, details);
};
