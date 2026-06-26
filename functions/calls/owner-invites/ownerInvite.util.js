const crypto = require("node:crypto");
const { throwAndLogHttpsError } = require("../../utils/error.util");

const OWNER_INVITES_COLLECTION = "ownerInvites";
const OWNER_INVITE_STATUSES = ["Draft", "Active", "Claimed", "Expired", "Disabled"];
const OWNER_INVITE_DEFAULT_PERKS = [
  "Founding Owner badge",
  "Priority listing review",
  "Assisted listing setup",
  "Featured placement for first approved listing",
];
const OWNER_INVITE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
const OWNER_INVITE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;

function normalizeOwnerInviteCode(value) {
  if (typeof value !== "string") {
    throwAndLogHttpsError("invalid-argument", "Enter a valid invite code.");
  }

  const code = value.trim().toUpperCase();
  if (!OWNER_INVITE_CODE_PATTERN.test(code)) {
    throwAndLogHttpsError("invalid-argument", "Enter a valid invite code.");
  }

  return code;
}

function normalizeOwnerInviteSlug(value) {
  if (typeof value !== "string") {
    throwAndLogHttpsError("invalid-argument", "Enter a valid invite link.");
  }

  const slug = value.trim().toLowerCase();
  if (!OWNER_INVITE_SLUG_PATTERN.test(slug)) {
    throwAndLogHttpsError("invalid-argument", "Enter a valid invite link.");
  }

  return slug;
}

function hashOwnerInviteValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function toMillis(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value._seconds === "number") return value._seconds * 1000;
  return null;
}

function isOwnerInviteExpired(invite, nowMillis = Date.now()) {
  const expiresAtMillis = toMillis(invite?.expiresAt);
  return expiresAtMillis !== null && expiresAtMillis <= nowMillis;
}

function isOwnerInvitePubliclyAvailable(invite, nowMillis = Date.now()) {
  return invite?.status === "Active" && !isOwnerInviteExpired(invite, nowMillis);
}

function publicOwnerInvitePayload(id, invite) {
  return {
    id,
    code: invite.code,
    displayName: invite.displayName,
    expiresAt: toMillis(invite.expiresAt),
    perks: Array.isArray(invite.perks) && invite.perks.length
      ? invite.perks.filter((perk) => typeof perk === "string" && perk.trim()).slice(0, 8)
      : OWNER_INVITE_DEFAULT_PERKS,
    slug: invite.slug || id,
    status: isOwnerInviteExpired(invite) ? "Expired" : invite.status,
    targetCategory: invite.targetCategory || null,
    targetLocation: invite.targetLocation || null,
  };
}

function ownerInvitePerks(invite) {
  return Array.isArray(invite?.perks) && invite.perks.length
    ? invite.perks.filter((perk) => typeof perk === "string" && perk.trim()).slice(0, 8)
    : OWNER_INVITE_DEFAULT_PERKS;
}

function buildFoundingOwnerUserPayload(inviteId, invite, claimedAt) {
  const inviteSlug = invite.slug || inviteId;
  const inviteCode = invite.code;
  return {
    inviteId,
    inviteSlug,
    inviteCode,
    code: inviteCode,
    displayName: invite.displayName,
    claimedAt,
    perks: ownerInvitePerks(invite),
    slug: inviteSlug,
    status: "Claimed",
    targetCategory: invite.targetCategory || null,
    targetLocation: invite.targetLocation || null,
  };
}

function ownerInviteClaimResult(id, invite, { claimed = false, alreadyClaimed = false } = {}) {
  return {
    invite: publicOwnerInvitePayload(id, invite),
    claimed,
    alreadyClaimed,
  };
}

module.exports = {
  OWNER_INVITES_COLLECTION,
  OWNER_INVITE_DEFAULT_PERKS,
  OWNER_INVITE_STATUSES,
  buildFoundingOwnerUserPayload,
  hashOwnerInviteValue,
  isOwnerInviteExpired,
  isOwnerInvitePubliclyAvailable,
  normalizeOwnerInviteCode,
  normalizeOwnerInviteSlug,
  ownerInviteClaimResult,
  publicOwnerInvitePayload,
  toMillis,
};
