const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fs = require("node:fs");
const path = require("node:path");
const PDFDocument = require("pdfkit");
const { throwAndLogHttpsError } = require("../utils/error.util");
const { getStorageBucket } = require("../utils/storageBucket.util");
const { BOOKING_STATUS, getBookingActors } = require("../utils/booking.util");

const DOCUMENT_TYPE = {
  receipt: "receipt",
  earnings: "earnings",
};

const CONTENT_VERSION = "2026-06-booking-doc-v4";
const PDF_CONTENT_TYPE = "application/pdf";
const LEND_LOGO_PATH = path.join(__dirname, "../assets/lend-logo.png");
const MAX_LISTING_IMAGE_BYTES = 3 * 1024 * 1024;
const PAGE = {
  left: 48,
  right: 547,
  width: 499,
};

exports.getBookingDocument = async (request) => {
  try {
    const auth = request.auth;
    const { bookingId, documentType } = request.data || {};

    if (!auth) {
      throwAndLogHttpsError("permission-denied", "User must be authenticated");
    }
    if (!bookingId || typeof bookingId !== "string") {
      throwAndLogHttpsError("invalid-argument", "Missing bookingId");
    }
    if (!Object.values(DOCUMENT_TYPE).includes(documentType)) {
      throwAndLogHttpsError("invalid-argument", "Invalid documentType");
    }

    const db = admin.firestore();
    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) {
      throwAndLogHttpsError("not-found", "Booking not found");
    }

    const booking = bookingSnap.data();
    assertDocumentAccess({ auth, booking, documentType });
    assertDocumentAvailable({ booking, documentType });

    const metadataField = documentType === DOCUMENT_TYPE.receipt ? "receipt" : "earnings";
    const storagePath = `${documentType === DOCUMENT_TYPE.receipt ? "bookingReceipts" : "bookingEarnings"}/${bookingId}/${
      documentType === DOCUMENT_TYPE.receipt ? "lend-receipt.pdf" : "lend-earnings.pdf"
    }`;
    const numberField = documentType === DOCUMENT_TYPE.receipt ? "receiptNumber" : "earningsNumber";
    const existing = booking?.[metadataField] || {};
    const documentNumber =
      typeof existing[numberField] === "string" && existing[numberField].trim()
        ? existing[numberField].trim()
        : buildDocumentNumber(documentType, bookingId);
    const bucket = getStorageBucket();
    const file = bucket.file(storagePath);
    const [fileExists] = await file.exists();
    let buffer = null;

    if (!fileExists || existing?.contentVersion !== CONTENT_VERSION || existing?.storagePath !== storagePath) {
      buffer = await buildBookingDocumentPdf({
        booking,
        bucket,
        documentType,
        documentNumber,
      });
      await file.save(buffer, {
        resumable: false,
        metadata: {
          contentType: PDF_CONTENT_TYPE,
          metadata: {
            bookingId,
            documentType,
            contentVersion: CONTENT_VERSION,
          },
        },
      });

      const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();
      const metadata = {
        [numberField]: documentNumber,
        storagePath,
        generatedAt: now,
        contentVersion: CONTENT_VERSION,
      };
      await writeDocumentMetadata({ db, booking, bookingRef, metadataField, metadata });
    }

    if (!buffer) {
      [buffer] = await file.download();
    }

    return {
      success: true,
      documentType,
      documentNumber,
      storagePath,
      fileName: buildDocumentFileName(documentType, bookingId),
      contentType: PDF_CONTENT_TYPE,
      contentBase64: buffer.toString("base64"),
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error("[getBookingDocument] Error", error);
    throwAndLogHttpsError("internal", error.message || "Unable to create booking document");
  }
};

function assertDocumentAccess({ auth, booking, documentType }) {
  if (auth?.token?.admin === true) return;
  const { ownerId, renterId } = getBookingActors(booking);
  if (documentType === DOCUMENT_TYPE.receipt && auth.uid === renterId) return;
  if (documentType === DOCUMENT_TYPE.earnings && auth.uid === ownerId) return;
  throwAndLogHttpsError("permission-denied", "You cannot access this booking document");
}

function assertDocumentAvailable({ booking, documentType }) {
  if (documentType === DOCUMENT_TYPE.receipt) {
    if (booking?.paymentFlow?.status !== "paid" || Number(booking?.paymentFlow?.amount || 0) <= 0) {
      throwAndLogHttpsError("failed-precondition", "Receipt is available after payment succeeds");
    }
    return;
  }

  if (booking?.status !== BOOKING_STATUS.completed) {
    throwAndLogHttpsError("failed-precondition", "Earnings are available after the booking is completed");
  }
  if (!booking?.payoutFlow && !booking?.settlement) {
    throwAndLogHttpsError("failed-precondition", "Earnings breakdown is not available yet");
  }
}

async function writeDocumentMetadata({ db, booking, bookingRef, metadataField, metadata }) {
  const assetId = booking?.asset?.id;
  const renterId = booking?.renter?.uid;
  const writes = [
    bookingRef.set(
      { [metadataField]: metadata, lastUpdated: admin.firestore.FieldValue?.serverTimestamp() || new Date() },
      { merge: true },
    ),
  ];
  if (metadataField === "receipt" && renterId) {
    writes.push(
      db
        .collection("users")
        .doc(renterId)
        .collection("bookings")
        .doc(booking.id)
        .set(
          { [metadataField]: metadata, lastUpdated: admin.firestore.FieldValue?.serverTimestamp() || new Date() },
          { merge: true },
        ),
    );
  }
  if (metadataField === "earnings" && assetId) {
    writes.push(
      db
        .collection("assets")
        .doc(assetId)
        .collection("bookings")
        .doc(booking.id)
        .set(
          { [metadataField]: metadata, lastUpdated: admin.firestore.FieldValue?.serverTimestamp() || new Date() },
          { merge: true },
        ),
    );
  }
  await Promise.all(writes);
}

function buildDocumentNumber(documentType, bookingId) {
  const prefix = documentType === DOCUMENT_TYPE.receipt ? "LR" : "LE";
  return `${prefix}-${bookingId.slice(0, 8).toUpperCase()}`;
}

function buildDocumentFileName(documentType, bookingId) {
  const label = documentType === DOCUMENT_TYPE.receipt ? "lend-receipt" : "lend-earnings";
  const safeBookingId = String(bookingId || "booking").replace(/[^a-zA-Z0-9_-]/g, "");
  return `${label}-${safeBookingId || "booking"}.pdf`;
}

async function buildBookingDocumentPdf({ booking, bucket = null, documentType, documentNumber }) {
  const listingImageBuffer = await loadListingImageBuffer({ booking, bucket });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 48,
      info: { Title: documentType === "receipt" ? "Lend Receipt" : "Lend Earnings" },
    });
    const buffers = [];
    doc.on("data", (chunk) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    drawHeader(doc, documentType, documentNumber);
    drawBookingDetails(doc, booking, listingImageBuffer);
    drawDivider(doc);
    if (documentType === DOCUMENT_TYPE.receipt) {
      drawRenterReceipt(doc, booking);
    } else {
      drawOwnerEarnings(doc, booking);
    }
    drawPolicy(doc, booking, documentType);
    drawFooter(doc);
    doc.end();
  });
}

function drawHeader(doc, documentType, documentNumber) {
  const title = documentType === DOCUMENT_TYPE.receipt ? "Lend Receipt" : "Lend Earnings";
  if (fs.existsSync(LEND_LOGO_PATH)) {
    doc.image(LEND_LOGO_PATH, PAGE.left, 44, { width: 42, height: 42 });
  } else {
    doc.roundedRect(PAGE.left, 44, 42, 42, 8).fill("#ff6b00");
    doc.fillColor("#ffffff").fontSize(18).font("Helvetica-Bold").text("L", 64, 55);
  }

  doc.fillColor("#111111").font("Helvetica-Bold").fontSize(23).text(title, 104, 48);
  doc.fillColor("#666666").font("Helvetica").fontSize(9).text("Transaction Summary", 104, 76);

  doc.fillColor("#666666").font("Helvetica").fontSize(8).text("Document no.", 360, 48, { width: 187, align: "right" });
  doc
    .fillColor("#111111")
    .font("Helvetica-Bold")
    .fontSize(10)
    .text(documentNumber, 360, 61, { width: 187, align: "right" });
  doc.fillColor("#666666").font("Helvetica").fontSize(8).text("Generated", 360, 78, { width: 187, align: "right" });
  doc
    .fillColor("#111111")
    .font("Helvetica-Bold")
    .fontSize(9)
    .text(formatDateTime(new Date()), 360, 91, { width: 187, align: "right" });

  doc.y = 126;
  drawDivider(doc);
}

async function loadListingImageBuffer({ booking, bucket }) {
  const imageRef = firstListingImageRef(booking?.asset);
  if (!isSupportedListingImageRef(imageRef)) return null;

  try {
    if (isHttpsUrl(imageRef)) {
      return await downloadHttpsListingImage(imageRef);
    }
    if (!bucket) return null;
    return await downloadStorageListingImage({ bucket, path: imageRef });
  } catch (error) {
    console.warn("[getBookingDocument] Unable to load listing image", error?.message || error);
    return null;
  }
}

function firstListingImageRef(asset) {
  const images = Array.isArray(asset?.images) ? asset.images : [];
  const showcase = Array.isArray(asset?.showcase) ? asset.showcase : [];
  return [...images, ...showcase].find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function isSupportedListingImageRef(value) {
  if (!value) return false;
  const normalized = decodeURIComponent(String(value).split("?")[0] || "");
  return /\.(png|jpe?g)$/i.test(normalized);
}

function isSupportedImageContentType(contentType) {
  return /^image\/(png|jpe?g)$/i.test(String(contentType || "").trim());
}

function isHttpsUrl(value) {
  return /^https:\/\//i.test(String(value || ""));
}

async function downloadHttpsListingImage(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) return null;

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_LISTING_IMAGE_BYTES) return null;
  if (!isSupportedImageContentType(response.headers.get("content-type")) && !isSupportedListingImageRef(url))
    return null;

  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.length <= MAX_LISTING_IMAGE_BYTES ? buffer : null;
}

async function downloadStorageListingImage({ bucket, path }) {
  const file = bucket.file(path);
  const [metadata] = await file.getMetadata();
  const size = Number(metadata?.size || 0);
  if (size > MAX_LISTING_IMAGE_BYTES) return null;
  if (!isSupportedImageContentType(metadata?.contentType) && !isSupportedListingImageRef(path)) return null;

  const [buffer] = await file.download();
  return buffer.length <= MAX_LISTING_IMAGE_BYTES ? buffer : null;
}

function drawBookingDetails(doc, booking, listingImageBuffer) {
  sectionTitle(doc, "Booking Details");
  listingCard(doc, {
    categoryName: booking?.asset?.categoryName || "Not specified",
    imageBuffer: listingImageBuffer,
    listingName: booking?.asset?.title || "Listing",
  });
  doc.moveDown(0.35);
  row(doc, "Booking ID", booking?.id || "");
  row(doc, "Dates", `${formatDate(booking?.startDate)} - ${formatDate(booking?.endDate)}`);
  row(doc, "Duration", booking?.numDays ? `${booking.numDays} ${booking.numDays === 1 ? "day" : "days"}` : "");
  row(doc, "Status", booking?.status || "");
  row(doc, "Renter", formatUserName(booking?.renter));
  row(doc, "Owner", formatUserName(booking?.asset?.owner));
}

function drawRenterReceipt(doc, booking) {
  const breakdown = booking?.priceBreakdown || {};
  const payment = booking?.paymentFlow || {};
  const processingFee = positiveSum([breakdown.renterPlatformFee, breakdown.renterProcessingFee]);
  sectionTitle(doc, "Payment");
  row(doc, "Payment method", formatPaymentMethod(payment));
  row(doc, "Payment status", formatStatus(payment.status || ""));
  row(doc, "Transaction ID", payment.transactionId || "");
  row(doc, "Checkout ID", payment.checkoutId || "");
  drawDivider(doc);
  sectionTitle(doc, "Price breakdown");
  moneyRow(doc, "Rental subtotal", breakdown.rentalSubtotal ?? booking?.totalPrice, booking);
  moneyRow(doc, "Security deposit", breakdown.securityDepositAmount, booking);
  moneyRow(doc, "Processing fee", processingFee, booking);
  moneyRow(
    doc,
    "VAT included in processing fee",
    estimateVatIncluded(processingFee, breakdown.paymentMethod?.vatRateBps),
    booking,
  );
  moneyRow(doc, "Total paid", breakdown.paymentAmount ?? payment.amount, booking, true);
}

function drawOwnerEarnings(doc, booking) {
  const breakdown = booking?.priceBreakdown || {};
  const payout = booking?.payoutFlow || {};
  const settlement = booking?.settlement || {};
  sectionTitle(doc, "Earnings");
  row(doc, "Payout status", formatStatus(payout.ownerPayoutStatus || settlement.ownerPayoutStatus || ""));
  row(doc, "Deposit return status", formatStatus(payout.depositReturnStatus || ""));
  moneyRow(doc, "Rental subtotal", breakdown.rentalSubtotal ?? booking?.totalPrice, booking);
  moneyRow(
    doc,
    "Approved damage deduction",
    settlement.approvedDamageDeductionAmount ?? booking?.disputeFlow?.approvedAmount,
    booking,
  );
  moneyRow(
    doc,
    "Deposit-covered amount",
    settlement.depositCoveredDamageAmount ?? booking?.disputeFlow?.depositCoveredAmount,
    booking,
  );
  moneyRow(doc, "Owner gross payout", payout.ownerPayoutGrossAmount, booking);
  moneyRow(doc, "Owner processing / transfer fees", payout.ownerProcessingFee ?? breakdown.ownerProcessingFee, booking);
  moneyRow(doc, "Previous cancellation deduction", payout.ownerPenaltyDeductionAmount, booking);
  moneyRow(
    doc,
    "Security deposit returned to renter",
    payout.depositReturnAmount ?? settlement.depositReturnAmount,
    booking,
  );
  moneyRow(
    doc,
    "Final owner payout",
    payout.ownerPayoutAmount ?? settlement.ownerPayoutAmount ?? breakdown.ownerPayoutAmount,
    booking,
    true,
  );
}

function drawPolicy(doc, booking, documentType) {
  drawDivider(doc);
  sectionTitle(doc, documentType === DOCUMENT_TYPE.receipt ? "Cancellation policy" : "Settlement policy");
  const text =
    documentType === DOCUMENT_TYPE.receipt
      ? "Refunds, date release, and applicable fees depend on booking status, payment provider status, Lend policy, and cancellation reason. Short-lead renter cancellations may be non-refundable for the rental payment while security deposits remain subject to settlement rules."
      : "Owner earnings are finalized after booking completion, settlement review, damage deduction decisions, applicable owner fees, transfer fees, and any owner cancellation penalty applications.";
  doc.font("Helvetica").fontSize(9).fillColor("#333333").text(text, { lineGap: 2 });
}

function drawFooter(doc) {
  const baseUrl = (process.env.LEND_WEB_BASE_URL || "").replace(/\/+$/, "");
  const y = 742;
  doc
    .strokeColor("#e5e5e5")
    .lineWidth(1)
    .moveTo(PAGE.left, y - 14)
    .lineTo(PAGE.right, y - 14)
    .stroke();
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#666666")
    .text("This document is generated from Lend booking records.", PAGE.left, y);
  linkedFooterLabel(doc, "Terms and Conditions", `${baseUrl}/terms-and-conditions`, PAGE.left, y + 15, 116);
  linkedFooterLabel(doc, "Privacy Policy", `${baseUrl}/privacy-policy`, 190, y + 15, 86);
  linkedFooterLabel(doc, "Help Center", `${baseUrl}/help-center`, 320, y + 15, 76);
}

function sectionTitle(doc, title) {
  doc.moveDown(0.9);
  const y = doc.y;
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111111").text(title, PAGE.left, y, {
    align: "left",
    width: PAGE.width,
  });
  doc.x = PAGE.left;
  doc.moveDown(0.25);
}

function listingCard(doc, { categoryName, imageBuffer, listingName }) {
  const y = doc.y;
  const cardHeight = 92;
  const imageSize = 68;
  const imageX = PAGE.left + 14;
  const imageY = y + 12;
  const textX = imageX + imageSize + 16;
  const textWidth = PAGE.width - imageSize - 44;

  doc.roundedRect(PAGE.left, y, PAGE.width, cardHeight, 6).lineWidth(1).strokeColor("#e5e5e5").stroke();
  if (imageBuffer) {
    doc.save();
    doc.roundedRect(imageX, imageY, imageSize, imageSize, 6).clip();
    doc.image(imageBuffer, imageX, imageY, {
      align: "center",
      fit: [imageSize, imageSize],
      valign: "center",
    });
    doc.restore();
  } else {
    doc.roundedRect(imageX, imageY, imageSize, imageSize, 6).fill("#f4f4f5");
    doc
      .fillColor("#999999")
      .font("Helvetica-Bold")
      .fontSize(18)
      .text("L", imageX, imageY + 23, {
        align: "center",
        width: imageSize,
      });
  }

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#666666")
    .text("Listing name", textX, y + 18, { width: textWidth });
  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor("#111111")
    .text(String(listingName), textX, y + 32, {
      width: textWidth,
      ellipsis: true,
    });
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#666666")
    .text("Category", textX, y + 57, { width: textWidth });
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#111111")
    .text(String(categoryName), textX, y + 70, {
      width: textWidth,
      ellipsis: true,
    });

  doc.y = y + cardHeight + 10;
}

function row(doc, label, value) {
  if (value == null || String(value).trim() === "") return;
  const y = doc.y;
  doc.font("Helvetica").fontSize(9).fillColor("#666666").text(label, PAGE.left, y, { width: 150 });
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#111111")
    .text(String(value), PAGE.left + 170, y, {
      width: PAGE.width - 170,
    });
  doc.moveDown(0.45);
}

function moneyRow(doc, label, amount, booking, isTotal = false) {
  if (!isPositive(amount) && !isTotal) return;
  const formatted = stripAmountSign(formatMoney(amount, booking));
  row(doc, label, formatted);
  if (isTotal) {
    doc.moveDown(0.2);
  }
}

function drawDivider(doc) {
  doc.moveDown(0.7);
  doc.strokeColor("#e5e5e5").lineWidth(1).moveTo(PAGE.left, doc.y).lineTo(PAGE.right, doc.y).stroke();
  doc.moveDown(0.3);
}

function linkedFooterLabel(doc, label, url, x, y, width) {
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#ff6b00").text(label, x, y, { width, link: url, underline: false });
}

function formatMoney(amount, booking) {
  const numeric = Math.abs(Number(amount || 0));
  const currency = normalizeCurrency(
    booking?.paymentFlow?.currency || booking?.priceBreakdown?.currency || booking?.asset?.rates?.currency,
  );
  const formatted = new Intl.NumberFormat("en-PH", {
    currency,
    currencyDisplay: "code",
    style: "currency",
  }).format(numeric);
  return stripAmountSign(formatted).replace(/\s+/g, " ");
}

function stripAmountSign(value) {
  return String(value || "").replace(/^\s*[+\-±]\s*/, "");
}

function formatDate(value) {
  const date = parseDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    date,
  );
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Manila",
  }).format(value);
}

function parseDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  return new Date(value);
}

function formatUserName(user) {
  return user?.displayName || [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() || "";
}

function formatStatus(value) {
  return String(value || "")
    .trim()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatPaymentMethod(payment) {
  const method = formatStatus(payment?.method || "");
  const last4 = payment?.methodDetails?.last4 ? ` ending in ${payment.methodDetails.last4}` : "";
  const bank = payment?.methodDetails?.bank_code ? ` (${String(payment.methodDetails.bank_code).toUpperCase()})` : "";
  return `${method}${last4}${bank}`.trim();
}

function normalizeCurrency(currency) {
  const normalized = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  return normalized || "PHP";
}

function isPositive(amount) {
  return Number.isFinite(Number(amount)) && Number(amount) > 0;
}

function positiveSum(amounts) {
  return amounts.reduce((sum, amount) => (isPositive(amount) ? sum + Number(amount) : sum), 0);
}

function estimateVatIncluded(amount, vatRateBps) {
  const numeric = Number(amount || 0);
  const rate = Number(vatRateBps || 0);
  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isFinite(rate) || rate <= 0) return 0;
  return Math.round((numeric - numeric / (1 + rate / 10000) + Number.EPSILON) * 100) / 100;
}

exports._test = {
  assertDocumentAvailable,
  buildDocumentNumber,
  buildDocumentFileName,
  buildBookingDocumentPdf,
  estimateVatIncluded,
  firstListingImageRef,
  formatMoney,
  formatPaymentMethod,
  isSupportedListingImageRef,
  stripAmountSign,
};
