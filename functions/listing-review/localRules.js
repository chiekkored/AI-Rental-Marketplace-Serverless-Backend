const LOCAL_RULE_CATEGORY = "test_spam_low_quality";

function reviewListingLocalRules(submission) {
  const failures = [];
  const title = normalizeText(submission?.title);
  const description = normalizeText(submission?.description);
  const combinedText = [
    title,
    description,
    normalizeText(submission?.categoryName),
    normalizeText(submission?.subcategoryName),
    normalizeText(submission?.ownerInstructions),
    ...(submission?.inclusions || []).map(normalizeText),
  ].join(" ");

  if (title.length < 3) {
    failures.push("Listing title is too short.");
  }
  if (description.length > 0 && description.length < 10) {
    failures.push("Listing description is too short.");
  }
  if (!submission?.categoryId || !submission?.categoryName) {
    failures.push("Listing category is required.");
  }
  if (!Number.isInteger(Number(submission?.rates?.daily)) || Number(submission?.rates?.daily) <= 0) {
    failures.push("Listing price is required.");
  }
  if (![...(submission?.images || []), ...(submission?.showcase || [])].length) {
    failures.push("At least one listing photo is required.");
  }
  if (looksLikeTestPost(combinedText)) {
    failures.push("Listing appears to be a test or placeholder post.");
  }
  if (containsContactOrPaymentBypass(combinedText)) {
    failures.push("Listing includes contact details or off-platform payment instructions.");
  }

  if (!failures.length) return null;

  return {
    decision: "reject",
    severity: "medium",
    categories: [LOCAL_RULE_CATEGORY],
    reasons: failures.slice(0, 10),
    providerResults: {
      localRules: {
        failed: true,
        reasons: failures,
      },
    },
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function looksLikeTestPost(text) {
  const normalized = text.toLowerCase();
  return (
    /\b(test|testing|sample|placeholder|dummy)\s+(post|listing|item|asset)\b/.test(normalized) ||
    /\b(asdf|qwerty|lorem ipsum)\b/.test(normalized)
  );
}

function containsContactOrPaymentBypass(text) {
  const normalized = text.toLowerCase();
  return (
    /\b(telegram|tg|whatsapp|viber|gcash\s+(direct|only)|pay\s+outside|outside\s+(lend|app)|direct\s+payment)\b/.test(
      normalized,
    ) ||
    /\b(contact|call|text|sms|message)\s+(me|us|owner)\b/.test(normalized) ||
    /(?:\+?63|0)\s?9\d{2}[\s.-]?\d{3}[\s.-]?\d{4}\b/.test(normalized)
  );
}

module.exports = {
  LOCAL_RULE_CATEGORY,
  reviewListingLocalRules,
  _test: {
    containsContactOrPaymentBypass,
    looksLikeTestPost,
  },
};
