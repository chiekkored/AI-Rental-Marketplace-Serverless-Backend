const assert = require("node:assert/strict");
const test = require("node:test");

const { reviewListingLocalRules } = require("../../listing-review/localRules");

function validSubmission(overrides = {}) {
  return {
    title: "Camera Kit",
    description: "Mirrorless camera for rent.",
    categoryId: "cameras",
    categoryName: "Cameras",
    rates: { daily: 1200, currency: "PHP" },
    images: ["users/owner/listingDrafts/draft-1/images/photo.jpg"],
    showcase: [],
    inclusions: [],
    ownerInstructions: "",
    ...overrides,
  };
}

test("local rules reject obvious test posts", () => {
  const review = reviewListingLocalRules(validSubmission({ title: "Test listing" }));

  assert.equal(review.decision, "reject");
  assert.match(review.reasons.join(" "), /test/i);
});

test("local rules reject too-short title", () => {
  const review = reviewListingLocalRules(validSubmission({ title: "VR" }));

  assert.equal(review.decision, "reject");
  assert.match(review.reasons.join(" "), /title/i);
});

test("local rules only check description length when description exists", () => {
  assert.equal(reviewListingLocalRules(validSubmission({ description: "" })), null);

  const review = reviewListingLocalRules(validSubmission({ description: "short" }));
  assert.equal(review.decision, "reject");
  assert.match(review.reasons.join(" "), /description/i);
});

test("local rules reject off-platform contact and payment bypass text", () => {
  for (const description of [
    "Message me on Telegram before renting.",
    "WhatsApp 09171234567 for direct payment.",
    "Pay outside Lend for discount.",
  ]) {
    const review = reviewListingLocalRules(validSubmission({ description }));
    assert.equal(review.decision, "reject");
    assert.match(review.reasons.join(" "), /off-platform|contact/i);
  }
});
