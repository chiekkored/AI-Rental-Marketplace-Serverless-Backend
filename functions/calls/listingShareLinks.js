const crypto = require("crypto");
const admin = require("firebase-admin");
const functions = require("firebase-functions");
const { throwAndLogHttpsError } = require("../utils/error.util");

const AVAILABLE_STATUS = "Available";
const LINK_CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LINK_CODE_LENGTH = 10;
const LINK_MODES = new Set(["attributed", "generic"]);
const RESOLVE_CONTEXTS = new Set(["app_open", "web_preview", "qr_scan"]);

function serverTimestamp() {
  return admin.firestore.FieldValue?.serverTimestamp() || new Date();
}

function increment(delta) {
  return admin.firestore.FieldValue?.increment(delta) || delta;
}

function normalizeCode(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAssetId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeMode(value) {
  return LINK_MODES.has(value) ? value : "attributed";
}

function normalizeResolveContext(value) {
  return RESOLVE_CONTEXTS.has(value) ? value : "app_open";
}

function randomCode(length = LINK_CODE_LENGTH) {
  const bytes = crypto.randomBytes(length);
  let code = "";
  for (const byte of bytes) {
    code += LINK_CODE_ALPHABET[byte % LINK_CODE_ALPHABET.length];
  }
  return code;
}

function getWebBaseUrl() {
  const configured = process.env.LEND_WEB_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return "https://getlend.dev";
}

function buildShareUrl(code) {
  return `${getWebBaseUrl()}/l/${encodeURIComponent(code)}`;
}

function indexIdFor({ assetId, mode, sharerId }) {
  const sharerKey = mode === "generic" ? "generic" : sharerId;
  return `${assetId}_${mode}_${sharerKey}`;
}

function assertAvailableAsset(assetSnap) {
  if (!assetSnap.exists) {
    throwAndLogHttpsError("not-found", "Listing not found");
  }

  const asset = assetSnap.data() || {};
  if (asset.isDeleted === true || asset.status !== AVAILABLE_STATUS) {
    throwAndLogHttpsError("failed-precondition", "Listing is unavailable");
  }

  return asset;
}

function publicListingSummary(assetId, asset) {
  const rates = asset.rates || {};
  const location = asset.location || {};
  const owner = asset.owner || {};
  return {
    id: assetId,
    title: asset.title || "Lend listing",
    description: asset.description || "",
    categoryName: asset.categoryName || "",
    subcategoryName: asset.subcategoryName || "",
    imageUrl: Array.isArray(asset.images) && asset.images.length > 0 ? asset.images[0] : null,
    price: {
      daily: rates.daily ?? null,
      weekly: rates.weekly ?? null,
      monthly: rates.monthly ?? null,
      currency: rates.currency || "PHP",
    },
    location: {
      locality: location.locality || "",
      administrativeAreaLevel1: location.administrativeAreaLevel1 || "",
      country: location.country || "",
    },
    owner: {
      name: owner.name || owner.firstName || "",
      photoUrl: owner.photoUrl || null,
    },
  };
}

async function createListingShareLink(request) {
  try {
    const auth = request.auth;
    const assetId = normalizeAssetId(request.data?.assetId);
    const mode = normalizeMode(request.data?.mode);

    if (!auth) {
      throwAndLogHttpsError("permission-denied", "User must be authenticated");
    }
    if (!assetId) {
      throwAndLogHttpsError("invalid-argument", "Missing assetId");
    }

    const db = admin.firestore();
    const assetRef = db.collection("assets").doc(assetId);
    const linkCollection = db.collection("listingShareLinks");
    const indexCollection = db.collection("listingShareLinkIndexes");
    const sharerId = mode === "generic" ? null : auth.uid;
    const indexRef = indexCollection.doc(indexIdFor({ assetId, mode, sharerId: auth.uid }));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = randomCode();
      const codeRef = linkCollection.doc(code);

      const result = await db.runTransaction(async (transaction) => {
        const [assetSnap, indexSnap, codeSnap] = await Promise.all([
          transaction.get(assetRef),
          transaction.get(indexRef),
          transaction.get(codeRef),
        ]);

        const asset = assertAvailableAsset(assetSnap);

        if (indexSnap.exists) {
          const existingCode = indexSnap.data()?.code;
          if (existingCode) {
            const existingRef = linkCollection.doc(existingCode);
            const existingSnap = await transaction.get(existingRef);
            if (existingSnap.exists) {
              transaction.update(existingRef, {
                lastRequestedAt: serverTimestamp(),
              });
              return {
                code: existingCode,
                url: buildShareUrl(existingCode),
                asset,
              };
            }
          }
        }

        if (codeSnap.exists) {
          return null;
        }

        const now = serverTimestamp();
        const link = {
          code,
          assetId,
          ownerId: asset.ownerId || null,
          sharerId,
          mode,
          createdAt: now,
          updatedAt: now,
          lastRequestedAt: now,
          totalResolves: 0,
          appOpenResolves: 0,
          webPreviewResolves: 0,
          qrScanResolves: 0,
        };

        transaction.set(codeRef, link);
        transaction.set(indexRef, {
          code,
          assetId,
          sharerId,
          mode,
          createdAt: now,
          updatedAt: now,
        });

        return {
          code,
          url: buildShareUrl(code),
          asset,
        };
      });

      if (result) {
        return {
          code: result.code,
          url: result.url,
          mode,
          assetId,
          title: result.asset.title || null,
        };
      }
    }

    throwAndLogHttpsError("resource-exhausted", "Unable to create share link");
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    functions.logger.error("createListingShareLink failed", error);
    throwAndLogHttpsError("internal", "Unable to create listing share link");
  }
}

async function resolveListingShareLink(request) {
  try {
    const code = normalizeCode(request.data?.code);
    const context = normalizeResolveContext(request.data?.context);
    const includePreview = request.data?.includePreview === true;

    return resolveListingShareCode({
      code,
      context,
      viewerId: request.auth?.uid || null,
      includePreview,
      userAgent: null,
      ip: null,
    });
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    functions.logger.error("resolveListingShareLink failed", error);
    throwAndLogHttpsError("internal", "Unable to resolve listing share link");
  }
}

async function resolveListingShareCode({
  code,
  context = "app_open",
  viewerId = null,
  includePreview = false,
  userAgent = null,
  ip = null,
}) {
  if (!code) {
    throwAndLogHttpsError("invalid-argument", "Missing code");
  }

  const db = admin.firestore();
  const linkRef = db.collection("listingShareLinks").doc(code);
  const eventRef = db.collection("listingShareEvents").doc();
  const normalizedContext = normalizeResolveContext(context);

  return db.runTransaction(async (transaction) => {
    const linkSnap = await transaction.get(linkRef);
    if (!linkSnap.exists) {
      throwAndLogHttpsError("not-found", "Share link not found");
    }

    const link = linkSnap.data() || {};
    const assetId = link.assetId;
    if (!assetId) {
      throwAndLogHttpsError("failed-precondition", "Share link is invalid");
    }

    const assetRef = db.collection("assets").doc(assetId);
    const assetSnap = await transaction.get(assetRef);
    const asset = assertAvailableAsset(assetSnap);

    const now = serverTimestamp();
    const contextCounter =
      normalizedContext === "web_preview"
        ? { webPreviewResolves: increment(1) }
        : normalizedContext === "qr_scan"
          ? { qrScanResolves: increment(1) }
          : { appOpenResolves: increment(1) };

    transaction.update(linkRef, {
      totalResolves: increment(1),
      lastResolvedAt: now,
      ...contextCounter,
    });

    transaction.set(eventRef, {
      id: eventRef.id,
      code,
      assetId,
      ownerId: link.ownerId || asset.ownerId || null,
      sharerId: link.sharerId || null,
      mode: link.mode || "attributed",
      viewerId,
      context: normalizedContext,
      userAgent,
      ip,
      createdAt: now,
    });

    return {
      code,
      assetId,
      mode: link.mode || "attributed",
      sharerId: link.sharerId || null,
      url: buildShareUrl(code),
      listing: includePreview ? publicListingSummary(assetId, asset) : undefined,
    };
  });
}

async function resolveListingShareLinkWeb(req, res) {
  try {
    if (req.method !== "GET") {
      res.set("Allow", "GET");
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    const result = await resolveListingShareCode({
      code: normalizeCode(req.query.code),
      context: "web_preview",
      viewerId: null,
      includePreview: true,
      userAgent: req.get("user-agent") || null,
      ip: req.ip || null,
    });

    res.set("Cache-Control", "private, max-age=0, no-store");
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof functions.https.HttpsError) {
      res.status(error.httpErrorCode?.status || 400).json({
        error: error.code,
        message: error.message,
      });
      return;
    }

    functions.logger.error("resolveListingShareLinkWeb failed", error);
    res.status(500).json({ error: "internal", message: "Unable to resolve listing share link" });
  }
}

exports.createListingShareLink = createListingShareLink;
exports.resolveListingShareLink = resolveListingShareLink;
exports.resolveListingShareLinkWeb = resolveListingShareLinkWeb;
exports._test = {
  buildShareUrl,
  indexIdFor,
  normalizeMode,
  normalizeResolveContext,
  publicListingSummary,
  randomCode,
};
