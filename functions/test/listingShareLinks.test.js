const assert = require("node:assert/strict");
const test = require("node:test");

const { _test } = require("../calls/listingShareLinks.js");

test("listing share helper builds stable share urls from configured base url", () => {
  const previous = process.env.LEND_WEB_BASE_URL;
  process.env.LEND_WEB_BASE_URL = "https://example.com/";

  try {
    assert.equal(_test.buildShareUrl("AbC123"), "https://example.com/l/AbC123");
  } finally {
    if (previous === undefined) {
      delete process.env.LEND_WEB_BASE_URL;
    } else {
      process.env.LEND_WEB_BASE_URL = previous;
    }
  }
});

test("listing share helper defaults to getlend.dev", () => {
  const previous = process.env.LEND_WEB_BASE_URL;
  delete process.env.LEND_WEB_BASE_URL;

  try {
    assert.equal(_test.buildShareUrl("AbC123"), "https://getlend.dev/l/AbC123");
  } finally {
    if (previous !== undefined) {
      process.env.LEND_WEB_BASE_URL = previous;
    }
  }
});

test("listing share helper normalizes modes and contexts", () => {
  assert.equal(_test.normalizeMode("generic"), "generic");
  assert.equal(_test.normalizeMode("attributed"), "attributed");
  assert.equal(_test.normalizeMode("other"), "attributed");

  assert.equal(_test.normalizeResolveContext("web_preview"), "web_preview");
  assert.equal(_test.normalizeResolveContext("qr_scan"), "qr_scan");
  assert.equal(_test.normalizeResolveContext("bad"), "app_open");
});

test("listing share helper summarizes only public listing fields", () => {
  const summary = _test.publicListingSummary("asset-1", {
    title: "Camera",
    description: "Mirrorless camera",
    categoryName: "Electronics",
    subcategoryName: "Cameras",
    images: ["https://example.com/camera.jpg"],
    rates: {
      daily: 500,
      currency: "PHP",
    },
    location: {
      locality: "Makati",
      administrativeAreaLevel1: "Metro Manila",
      country: "Philippines",
      lat: 14.1,
      lng: 121.1,
    },
    owner: {
      name: "Alex",
      phone: "hidden",
    },
    ownerInstructions: "hidden",
  });

  assert.deepEqual(summary, {
    id: "asset-1",
    title: "Camera",
    description: "Mirrorless camera",
    categoryName: "Electronics",
    subcategoryName: "Cameras",
    imageUrl: "https://example.com/camera.jpg",
    price: {
      daily: 500,
      weekly: null,
      monthly: null,
      currency: "PHP",
    },
    location: {
      locality: "Makati",
      administrativeAreaLevel1: "Metro Manila",
      country: "Philippines",
    },
    owner: {
      name: "Alex",
      photoUrl: null,
    },
  });
});
