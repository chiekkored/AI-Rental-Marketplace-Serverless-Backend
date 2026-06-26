const assert = require("node:assert/strict");
const test = require("node:test");

const {
  hashOwnerInviteValue,
  buildFoundingOwnerUserPayload,
  isOwnerInviteExpired,
  isOwnerInvitePubliclyAvailable,
  normalizeOwnerInviteCode,
  normalizeOwnerInviteSlug,
  ownerInviteClaimResult,
  publicOwnerInvitePayload,
} = require("../calls/owner-invites/ownerInvite.util");

test("normalizes owner invite code and slug", () => {
  assert.equal(normalizeOwnerInviteCode(" juan-8k2 "), "JUAN-8K2");
  assert.equal(normalizeOwnerInviteSlug(" Juan-Camera-Rentals "), "juan-camera-rentals");
});

test("detects expired owner invites", () => {
  const invite = {
    status: "Active",
    expiresAt: new Date("2026-06-01T00:00:00.000Z"),
  };

  assert.equal(isOwnerInviteExpired(invite, Date.parse("2026-06-02T00:00:00.000Z")), true);
  assert.equal(isOwnerInvitePubliclyAvailable(invite, Date.parse("2026-05-31T00:00:00.000Z")), true);
  assert.equal(isOwnerInvitePubliclyAvailable(invite, Date.parse("2026-06-02T00:00:00.000Z")), false);
});

test("builds public owner invite payload without private fields", () => {
  const invite = {
    adminNotes: "private",
    code: "JUAN-8K2",
    displayName: "Juan Camera Rentals",
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    perks: ["Founding Owner badge"],
    slug: "juan-camera-rentals",
    status: "Active",
    targetCategory: "Camera gear",
    targetLocation: "Cebu City",
  };

  assert.deepEqual(publicOwnerInvitePayload("juan-camera-rentals", invite), {
    code: "JUAN-8K2",
    displayName: "Juan Camera Rentals",
    expiresAt: Date.parse("2026-09-01T00:00:00.000Z"),
    id: "juan-camera-rentals",
    perks: ["Founding Owner badge"],
    slug: "juan-camera-rentals",
    status: "Active",
    targetCategory: "Camera gear",
    targetLocation: "Cebu City",
  });
  assert.equal(hashOwnerInviteValue("JUAN-8K2").length, 64);
});

test("builds durable founding owner user payload", () => {
  const claimedAt = new Date("2026-06-20T00:00:00.000Z");
  const invite = {
    code: "JUAN-8K2",
    displayName: "Juan Camera Rentals",
    perks: ["Founding Owner badge"],
    slug: "juan-camera-rentals",
    targetCategory: "Camera gear",
    targetLocation: "Cebu City",
  };

  assert.deepEqual(buildFoundingOwnerUserPayload("juan-camera-rentals", invite, claimedAt), {
    code: "JUAN-8K2",
    claimedAt,
    displayName: "Juan Camera Rentals",
    inviteCode: "JUAN-8K2",
    inviteId: "juan-camera-rentals",
    inviteSlug: "juan-camera-rentals",
    perks: ["Founding Owner badge"],
    slug: "juan-camera-rentals",
    status: "Claimed",
    targetCategory: "Camera gear",
    targetLocation: "Cebu City",
  });
});

test("builds distinct owner invite claim result states", () => {
  const invite = {
    code: "JUAN-8K2",
    displayName: "Juan Camera Rentals",
    perks: ["Founding Owner badge"],
    slug: "juan-camera-rentals",
    status: "Claimed",
  };

  assert.deepEqual(ownerInviteClaimResult("juan-camera-rentals", invite, { claimed: true }), {
    alreadyClaimed: false,
    claimed: true,
    invite: {
      code: "JUAN-8K2",
      displayName: "Juan Camera Rentals",
      expiresAt: null,
      id: "juan-camera-rentals",
      perks: ["Founding Owner badge"],
      slug: "juan-camera-rentals",
      status: "Claimed",
      targetCategory: null,
      targetLocation: null,
    },
  });

  assert.deepEqual(ownerInviteClaimResult("juan-camera-rentals", invite, { alreadyClaimed: true }), {
    alreadyClaimed: true,
    claimed: false,
    invite: {
      code: "JUAN-8K2",
      displayName: "Juan Camera Rentals",
      expiresAt: null,
      id: "juan-camera-rentals",
      perks: ["Founding Owner badge"],
      slug: "juan-camera-rentals",
      status: "Claimed",
      targetCategory: null,
      targetLocation: null,
    },
  });
});
