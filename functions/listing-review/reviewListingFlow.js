const { genkit, z } = require("genkit");
const { googleAI } = require("@genkit-ai/google-genai");

const moderationCategories = [
  "unrelated_to_rental",
  "illegal_item",
  "stolen_or_suspicious_ownership",
  "counterfeit_or_fake_brand",
  "weapon_or_dangerous_item",
  "drug_or_controlled_substance",
  "live_animals_or_restricted_goods",
  "service_instead_of_rental",
  "external_payment_or_contact_bypass",
  "scam_or_deceptive_pricing",
  "test_spam_low_quality",
  "spam_or_duplicate",
  "unsafe_or_high_risk_item",
  "owner_compliance_document_review",
];

const ReviewInputSchema = z.object({
  submissionType: z.enum(["create", "update"]),
  title: z.string().min(1).max(120),
  description: z.string().max(2000),
  categoryName: z.string().min(1).max(120),
  subcategoryName: z.string().max(120).nullable().optional(),
  listingKind: z.string().max(80).nullable().optional(),
  detailSchemaKey: z.string().max(80).nullable().optional(),
  details: z.record(z.any()).optional(),
  rates: z.object({
    daily: z.number().int().positive(),
    weekly: z.number().int().positive().nullable().optional(),
    monthly: z.number().int().positive().nullable().optional(),
    annually: z.number().int().positive().nullable().optional(),
    currency: z.string().max(8).nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
  }),
  inclusions: z.array(z.string().max(80)).max(30),
  ownerInstructions: z.string().max(1000).nullable().optional(),
  securityDeposit: z.object({
    enabled: z.boolean(),
    amount: z.number().int().min(0),
  }),
});

const ReviewOutputSchema = z.object({
  decision: z.enum(["approve", "manual_review", "reject"]),
  severity: z.enum(["low", "medium", "high"]),
  categories: z.array(z.enum(moderationCategories)),
  reasons: z.array(z.string().min(1).max(300)).max(10),
  safeTitleSuggestion: z.string().max(120).optional(),
  safeDescriptionSuggestion: z.string().max(2000).optional(),
});

const ai = genkit({
  plugins: [googleAI()],
  model: googleAI.model(process.env.LISTING_REVIEW_MODEL || "gemini-2.5-flash-lite", {
    temperature: 0.1,
    thinkingConfig: {
      thinkingBudget: 0,
    },
  }),
});

const reviewListingFlow = ai.defineFlow(
  {
    name: "reviewListingFlow",
    inputSchema: ReviewInputSchema,
    outputSchema: ReviewOutputSchema,
  },
  async (input) => {
    const prompt = buildReviewPrompt(input);

    const { output } = await ai.generate({
      prompt,
      output: { schema: ReviewOutputSchema },
      config: {
        temperature: 0.1,
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    });

    if (!output) {
      throw new Error("Listing moderation did not return structured output");
    }

    return output;
  },
);

function buildReviewPrompt(input) {
  return [
    "You are reviewing a Lend peer-to-peer rental marketplace listing before publication.",
    "Classify the listing using only the JSON schema. This is a text-only business-quality review; image safety moderation has already run separately.",
    "",
    "Decision rules:",
    "- approve: normal rentable physical asset with no obvious policy issues.",
    "- manual_review: might be valid but needs admin review, including vague ownership, suspicious documents, possible counterfeit goods, unclear physical rental vs service, vague deposit terms, or high-risk expensive items.",
    "- reject: clearly prohibited marketplace content, including illegal goods, weapons, explosives/fireworks, drugs, counterfeit goods, stolen item language, scam/misleading posts, external payment/contact bypass, unrelated content, services instead of rentals, or test/spam/low-quality submissions.",
    "- Do not duplicate the separate safety moderation stage for sexual, violent, hate, harassment, or self-harm content unless the text also creates a marketplace-quality violation.",
    "",
    "Normal examples: camera rental, speaker rental, camping tent rental, power tool rental, car rental, event equipment rental, appliance rental, game console rental.",
    "",
    "Listing:",
    `Submission type: ${input.submissionType}`,
    `Title: ${input.title}`,
    `Category: ${input.categoryName}`,
    `Subcategory: ${input.subcategoryName || "(none)"}`,
    `Listing kind: ${input.listingKind || "(none)"}`,
    `Detail schema: ${input.detailSchemaKey || "(none)"}`,
    `Details: ${JSON.stringify(input.details || {})}`,
    `Description: ${input.description || "(empty)"}`,
    `Inclusions: ${input.inclusions.join(", ") || "(none)"}`,
    `Owner instructions: ${input.ownerInstructions || "(none)"}`,
    `Daily rate: ${input.rates.daily} ${input.rates.currency || ""}`.trim(),
    `Security deposit: ${input.securityDeposit.enabled ? input.securityDeposit.amount : "disabled"}`,
  ].join("\n");
}

module.exports = {
  ReviewInputSchema,
  ReviewOutputSchema,
  moderationCategories,
  reviewListingFlow,
  _test: { buildReviewPrompt },
};
