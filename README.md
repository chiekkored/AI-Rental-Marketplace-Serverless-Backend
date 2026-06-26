# Lend Serverless

## Local development

Use Node.js 22 for local Functions work. The Functions runtime in
`functions/package.json` is also set to Node.js 22.

Use the VS Code launch configs for local emulator startup:

- `Serverless Local Emulators` starts the full emulator suite.
- `Serverless Functions Only` starts only the Functions emulator.

VS Code tasks are deploy-only. This avoids background task lifecycle issues
while keeping local emulator terminals visible.

From the serverless project root, the equivalent full-suite command is:

```sh
cd lend-serverless
firebase emulators:start
```

For Functions only:

```sh
cd lend-serverless/functions
npm install
npm test
npm run serve
```

Local Functions configuration lives in `functions/.env`. Keep local/test
values there, including `FUNCTIONS_EMULATOR=true` and PayMongo test keys in the
canonical `PAYMONGO_SECRET_KEY`, `PAYMONGO_PUBLIC_KEY`, and
`PAYMONGO_WEBHOOK_SECRET` variables.

If startup fails because port `5001` is taken, stop the stale local emulator
process and launch again. If Functions discovery is slow, the VS Code launch
configs set `FUNCTIONS_DISCOVERY_TIMEOUT=30000` for local emulator runs.

Deploy Functions from the serverless project root:

```sh
cd lend-serverless
firebase use production
firebase deploy --only functions
```

Production Functions configuration should live in a local, uncommitted
`functions/.env.production` file based on `functions/.env.production.example`.
The `production` Firebase alias maps to `lend-api`, so Firebase loads
`functions/.env` and `functions/.env.production` during production deploys, with
the production-specific file overriding duplicate keys.

## Booking and settlement logic

`bookings/{bookingId}` is the canonical booking source of truth for renter, owner, and admin reads. The renter mirror at `users/{renterId}/bookings/{bookingId}` and asset mirror at `assets/{assetId}/bookings/{bookingId}` are updated from the canonical booking for mobile list/detail reads.

Payment and booking lifecycle:

1. Mobile calls `createPaymentCheckout` with the asset, date range, price, and selected PayMongo method.
2. The function validates the listing, renter, payout destination, renter deposit return destination when needed, date availability, and Remote Config pricing policy.
3. The function creates temporary date locks at `assets/{assetId}/bookingDateLocks/{yyyy-mm-dd}` and writes `paymentCheckouts/{checkoutId}`.
4. PayMongo creates a Payment Intent. Mobile completes the card, e-wallet, QR, DOB, or Brankas flow.
5. `paymongoWebhook` or `syncPaymentCheckout` confirms successful payment and creates the canonical booking, mirrors, booking chat, lifecycle events, and booked date locks.
6. QR handover marks the booking handed over.
7. QR return marks the booking returned and sets `settlement.status = "awaiting_owner_action"`.
8. Final settlement only starts through owner complete rental, admin damage resolution, or admin/timeout auto-complete.

Returned status is only a compliance/status checkpoint. It must not finalize the rental, release owner payout, or return the security deposit.

Post-return settlement actions:

- `owner_complete`: owner completes the rental. If the booking is not risk flagged, the function marks the booking completed, starts owner payout, and starts full deposit return when a security deposit exists. Risk-flagged bookings move to admin review.
- `owner_request_damage_deduction`: owner submits requested deduction amount, reason, evidence URLs when supported, and notes. The booking moves to `damage_deduction_requested`; renter deposit status moves to `awaiting_renter_response`.
- `renter_accept_damage_deduction` or `renter_dispute_damage_deduction`: renter response is recorded and settlement moves to `admin_review_required`. No money is settled.
- `admin_resolve_damage_deduction`: admin approves full amount, approves adjusted amount, or rejects the deduction. The function calculates the approved deduction, starts deposit return for the remainder, starts owner payout according to settlement rules, and marks settlement completed.

MVP rule: every damage deduction request requires admin approval, even when the renter accepts.

## Remote Config pricing policy

Do not hardcode fee rates or checkout/settlement timeouts in Functions. Pricing and policy values are loaded from Firebase Remote Config parameter `lend_pricing_policy`.

Expected JSON shape:

```json
{
  "checkout_lock_expiry_minutes_by_method": {
    "default": 15,
    "card": 15,
    "gcash": 30,
    "paymaya": 30,
    "grab_pay": 30,
    "shopeepay": 30,
    "qrph": 30,
    "dob": 45,
    "brankas": 45
  },
  "owner_return_action_timeout_hours": 48,
  "payment_method_fee_vat_rate_bps": 1200,
  "payment_method_fees": {
    "card": {
      "label": "Cards",
      "domestic": {
        "rate_bps": 312.5,
        "fixed_amount": 13.39,
        "calculation": "rate_plus_fixed"
      },
      "international": {
        "rate_bps": 402,
        "fixed_amount": 13.39,
        "calculation": "rate_plus_fixed"
      }
    },
    "gcash": {
      "label": "GCash",
      "rate_bps": 223,
      "fixed_amount": 0,
      "calculation": "rate_only"
    },
    "paymaya": {
      "label": "Maya",
      "rate_bps": 179,
      "fixed_amount": 0,
      "calculation": "rate_only"
    },
    "grab_pay": {
      "label": "GrabPay",
      "rate_bps": 196,
      "fixed_amount": 0,
      "calculation": "rate_only"
    },
    "shopeepay": {
      "label": "ShopeePay",
      "rate_bps": 170,
      "fixed_amount": 0,
      "calculation": "rate_only"
    },
    "qrph": {
      "label": "QR Ph",
      "rate_bps": 134,
      "fixed_amount": 0,
      "calculation": "rate_only"
    },
    "dob": {
      "label": "Direct Online Banking",
      "default": {
        "rate_bps": 71,
        "fixed_amount": 13.39,
        "calculation": "max_rate_or_fixed"
      },
      "banks": {}
    },
    "brankas": {
      "label": "Direct Online Banking",
      "default": {
        "rate_bps": 71,
        "fixed_amount": 13.39,
        "calculation": "max_rate_or_fixed"
      },
      "banks": {}
    }
  },
  "platform_fee": {
    "rate_bps": 0,
    "fixed_amount": 0,
    "calculation": "rate_plus_fixed"
  },
  "wallet_transfer_fee": {
    "rate_bps": 0,
    "fixed_amount": 10,
    "calculation": "fixed_only"
  }
}
```

Security deposit rules:

- The renter pays the rental processing fee and the Lend platform fee configured by `platform_fee`; the platform fee is calculated from the rental subtotal.
- Payment method fee estimates include `payment_method_fee_vat_rate_bps`.
- If security deposit is enabled, the owner pays the selected payment method fee estimate for collecting the security deposit.
- If security deposit is disabled, the owner pays the owner payout wallet transfer fee, and no deposit dispute flow is needed.
- If security deposit is enabled, the owner also pays the wallet transfer fee for returning the security deposit to the renter, and all damage deductions require admin approval before settlement.
- Deposit return is a PayMongo wallet payout to the renter payout destination saved as `depositReturnDestination`; it is not a PayMongo refund.

## Production Cloud Tasks setup

`confirmBooking` enqueues overlap cleanup work to Cloud Tasks after the selected booking is confirmed. Production must have this queue before booking confirmation can report `phase2: "enqueued"`.

Required queue path:

```
projects/lend-54b2e/locations/us-central1/queues/decline-overlapping-bookings
```

Create and verify the queue:

```sh
gcloud services enable cloudtasks.googleapis.com --project=lend-54b2e

gcloud tasks queues create decline-overlapping-bookings \
  --project=lend-54b2e \
  --location=us-central1

gcloud tasks queues describe decline-overlapping-bookings \
  --project=lend-54b2e \
  --location=us-central1
```

Required production configuration:

```sh
DECLINE_FUNCTIONS_URL=https://<deployed-declineOverlappingBookings-url>
TASKS_SERVICE_ACCOUNT_EMAIL=<service-account-used-for-cloud-tasks-oidc>
```

IAM requirements:

- The service account running `confirmBooking` needs `roles/cloudtasks.enqueuer` for the queue project.
- The `TASKS_SERVICE_ACCOUNT_EMAIL` service account must be allowed to invoke `declineOverlappingBookings`.

Operational check:

- A successful booking confirmation should return `phase2: "enqueued"`.
- Function logs should include `[enqueueDeclineTask] Created task: ...`.
- `declineOverlappingBookings` logs should show the task payload being processed.

## PayMongo payment setup

Bookings now use a custom PayMongo Payment Intent flow. Card details are tokenized from the mobile app with the PayMongo public key; the secret key stays in Cloud Functions. GCash, Maya, GrabPay, ShopeePay, QR Ph, DOB, and Brankas are one-time redirect or QR flows.

Card vaulting is disabled in the app and checkout function for now because PayMongo currently rejects `setup_future_usage.session_type = "on_session"` for this integration with `On session payments are not yet supported.` Existing vaulted cards may still be charged through the saved-card callable.

Required Functions environment variables:

```sh
PAYMONGO_SECRET_KEY=sk_test_or_live_...
PAYMONGO_PUBLIC_KEY=pk_test_or_live_...
PAYMONGO_WEBHOOK_SECRET=<webhook signing secret>
PAYMONGO_RETURN_URL=https://getlend.dev/payment/return
PAYMONGO_WALLET_ID=<wallet id used for owner payouts>
PAYMONGO_PAYOUT_CALLBACK_URL=https://<optional wallet transaction callback url>
```

Operational requirements:

- Enable PayMongo Payment Intents, the payment channels configured in Admin > Settings > Configurations > Payment Methods, and Money Movement / Wallet payouts on the PayMongo account.
- Register the deployed `paymongoWebhook` URL in PayMongo and subscribe to `payment.paid`, `payment.failed`, and QR expiry events.
- Deploy the customer-facing web app so `https://getlend.dev/payment/return` and the `/.well-known` app association files are publicly available.
- Owners must add a payout destination in the mobile app before renters can pay for their listings.
- Renters must add a deposit return destination before booking listings with security deposits.
- Renter payments go first to the Lend PayMongo merchant/payment account through a Payment Intent. Owners do not receive funds immediately.
- Owner payout happens only after owner completion, admin dispute resolution, or auto-complete timeout.
- Security deposit return is processed separately as a wallet payout after owner completion, admin dispute resolution, or auto-complete timeout.
- Return QR confirmation only marks the booking returned and moves settlement to owner action. It must not release owner payout or return security deposit funds.
