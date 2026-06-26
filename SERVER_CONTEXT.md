# Lend Serverless Backend Context

## 1. Executive Summary

This repository is a narrow Firebase Cloud Functions backend for critical booking and QR handoff flows in Lend, a peer-to-peer rental marketplace. It currently acts as the authority for booking confirmation, QR token generation, QR verification, return/handover marking, and overlap cleanup, with chat-side system messaging as a booking side effect.

The implementation is materially smaller than the intended product scope. There are no payment handlers, admin workflows, fraud modules, HTTP APIs for public clients, or active scheduled jobs in this repo. The real backend surface today is:

- create booking requests
- confirm a booking
- generate or regenerate QR tokens
- verify QR tokens
- mark handover/return complete
- asynchronously decline overlapping pending bookings
- send system chat messages as booking side effects

The code shows a backend that is directionally correct in one important way: critical booking lifecycle changes are server-side, not purely client-side. It is still not production-grade. The largest remaining issues are duplicated booking state across two Firestore locations, minimal operational observability, and callable/task behavior that still needs broader contract coverage.

## 2. Architecture Overview

### Repository Shape

- `functions/index.js`: deployment entrypoint and export registry
- `functions/calls/*`: callable functions and one HTTP task handler
- `functions/utils/*`: token signing, chat side effects, error helper
- `functions/scheduled/syncUserMetadata.js`: designed scheduled job, currently commented out
- `firebase.json`: functions source and emulator config
- `firestore.rules`: Firestore security contract
- `storage.rules`: Cloud Storage rules
- `firestore.indexes.json`: source-controlled Firestore index definitions
- `functions/test/rules.test.js`: emulator-backed Firestore and Storage rules scenarios

### Runtime and Deployment Style

- Node.js `22` runtime declared in [`functions/package.json`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/package.json:1)
- CommonJS JavaScript, not TypeScript
- Firebase Functions v1-style APIs via `functions.https.onCall` and `functions.https.onRequest`
- Firebase Admin initialized once with application default credentials in [`functions/index.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/index.js:11)
- Default Firebase project is `lend-54b2e` in [`.firebaserc`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/.firebaserc:1)

### Config and Environment

- `QR_SECRET` is required at module load time by token-related functions and `token.util`
- `GCP_PROJECT` is required indirectly for Cloud Tasks enqueue URL/path generation in [`functions/calls/confirmBooking.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/confirmBooking.js:148)
- Functions call `dotenv.config()`, implying local `.env` usage; no production config strategy is documented
- VS Code launch configs now exist for local emulator running and deploy-oriented production workflows in both the serverless repo and the shared workspace root
- Local emulator startup is standardized on `nvm use 20` plus Firebase import/export persistence via `emulator-data`
- Firestore and Storage rules coverage runs through `npm run test:rules`
- The full local emulator stack requires Java 21+ because the current `firebase-tools` version will not run the Firestore emulator on older Java releases

### Active vs Inactive Backend Surface

Active exports in [`functions/index.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/index.js:16):

- `createBookingRequest`
- `makeToken`
- `verifyAndMark`
- `regenerateToken`
- `verifyToken`
- `confirmBooking`
- `submitBookingReview`
- `declineOverlappingBookings`

Inactive but present:

- `syncUserMetadata` is imported but not exported; the implementation itself is fully commented out in [`functions/scheduled/syncUserMetadata.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/scheduled/syncUserMetadata.js:13)

## 3. Function Registry

### `createBookingRequest`

Purpose:

- Creates the initial pending booking request
- Writes both booking mirrors
- Creates the shared chat root and first message
- Creates both `userChats` mirrors

Observed behavior:

- Requires auth and treats `request.auth.uid` as the renter
- Loads the canonical asset and renter documents before writing
- Prevents owner self-booking
- Rejects overlapping active bookings for the requested range
- Writes the current booking schema with `startDate`, `endDate`, and `numDays`

### `makeToken`

Source: [`functions/calls/makeToken.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/makeToken.js:14)

Purpose:

- Generates signed handover and return QR tokens for a booking
- Stores them into both booking copies:
  - `users/{userId}/bookings/{bookingId}`
  - `assets/{assetId}/bookings/{bookingId}`

Observed behavior:

- Requires auth and now verifies the caller is a booking participant
- Validates request renter identity against booking data before writing
- Reads booking from the asset-side booking doc and writes both booking mirrors transactionally
- Uses `endDate` as the basis for both handover and return token expiry

### `regenerateToken`

Source: [`functions/calls/regenerateToken.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/regenerateToken.js:18)

Purpose:

- Rotates booking QR tokens and overwrites prior tokens in both booking copies

Observed behavior:

- Requires auth and now verifies the caller is a booking participant
- Requires `Confirmed` or `HandedOver` status and rejects returned/completed bookings
- Regenerates a full `tokens` object including expiry fields in both booking mirrors

### `verifyToken`

Source: [`functions/calls/verifyToken.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/verifyToken.js:18)

Purpose:

- Validates a QR token without mutating booking state

Observed behavior:

- Requires auth
- Verifies HMAC signature
- Verifies token expiry
- Reads asset-side booking doc
- Compares the full token string against the token stored in Firestore
- Enforces action-specific lifecycle status and scanner authorization
- Requires `Confirmed` for handover and `HandedOver` for return

### `verifyAndMark`

Source: [`functions/calls/verifyAndMark.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/verifyAndMark.js:13)

Purpose:

- Verifies a QR token and marks either handover or return complete
- Appends booking events
- Sends system chat messages
- Sends rating prompt after return
- Archives owner chat after return

Observed behavior:

- Requires auth
- Verifies token signature and expiry
- Compares the presented token against the stored booking token before mutation
- Enforces action-specific lifecycle status and scanner authorization
- Moves `Confirmed -> HandedOver` or `HandedOver -> Returned`
- Writes deterministic lifecycle event documents under both booking mirrors

### `confirmBooking`

Source: [`functions/calls/confirmBooking.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/confirmBooking.js:18)

Purpose:

- Confirms one booking atomically
- Writes a system confirmation message into chat
- Updates renter and owner `userChats`
- Enqueues an async cleanup to decline overlapping pending bookings

Observed behavior:

- Requires auth and verifies the caller is the asset owner for the selected booking
- Validates renter identity against the stored booking
- Checks that asset-side booking status is `"Pending"`
- Updates both duplicated booking docs to `"Confirmed"` and now generates QR tokens in the same transaction
- Uses a two-phase model:
  - phase 1: synchronous transaction for selected booking
  - phase 2: async Cloud Task for overlap cleanup

### `declineOverlappingBookings`

Source: [`functions/calls/declineOverlappingBookings.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/declineOverlappingBookings.js:14)

Purpose:

- HTTP endpoint intended for Cloud Tasks
- Finds overlapping pending bookings for an asset and declines them

Observed behavior:

- Accepts `POST` only
- Verifies Cloud Tasks OIDC in production and allows emulator traffic locally
- Expects raw JSON payload matching the enqueued task body
- Queries `assets/{assetId}/bookings` for overlapping `"Pending"` docs
- Batch-updates asset booking, user booking, and renter chat metadata
- Does not send decline chat messages or notify owner chat

### `sendSystemChatMessage`

Source: [`functions/utils/chat.util.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/utils/chat.util.js:3)

Purpose:

- Reusable helper to write a system chat message and update `userChats` metadata

Observed behavior:

- Updates `lastMessage` metadata only for the included side(s)
- Supports suppressing last-message updates when the caller passes `includeLastMessage: false`

### `throwAndLogHttpsError`

Source: [`functions/utils/error.util.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/utils/error.util.js:10)

Purpose:

- Logs and throws Firebase `HttpsError`

Observed behavior:

- Logs serialized details
- Frequently used with raw internal error messages

### `syncUserMetadata` (inactive)

Source: [`functions/scheduled/syncUserMetadata.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/scheduled/syncUserMetadata.js:1)

Intended purpose:

- Daily denormalized user metadata repair across bookings and chats

Reality:

- Not exported
- Entire implementation is commented out
- No scheduled job is deployed from this repository

## 4. Firestore Write Map

### Collections and Subcollections Actually Used

- `users/{uid}`
- `users/{uid}/bookings/{bookingId}`
- `users/{uid}/bookings/{bookingId}/events/{eventId}`
- `assets/{assetId}/bookings/{bookingId}`
- `assets/{assetId}/bookings/{bookingId}/events/{eventId}`
- `chats/{chatId}/messages/{messageId}`
- `userChats/{uid}/chats/{chatId}`

### Function-by-Function Read/Write Map

| Function | Reads | Writes |
|---|---|---|
| `createBookingRequest` | `assets/{assetId}`, `users/{renterId}`, overlap query on `assets/{assetId}/bookings` | both booking mirrors, `chats/{chatId}`, first message, both `userChats` roots/summaries |
| `makeToken` | `assets/{assetId}/bookings/{bookingId}` | `users/{userId}/bookings/{bookingId}`, `assets/{assetId}/bookings/{bookingId}` |
| `regenerateToken` | `assets/{assetId}/bookings/{bookingId}`, both booking copies in transaction | `users/{userId}/bookings/{bookingId}`, `assets/{assetId}/bookings/{bookingId}` |
| `verifyToken` | `assets/{assetId}/bookings/{bookingId}` | none |
| `verifyAndMark` | both booking copies | both booking copies, both `events` subcollections, `chats/{chatId}/messages`, owner/renter `userChats`, then owner `userChats` archive on return |
| `confirmBooking` | `assets/{assetId}/bookings/{bookingId}` | both booking copies, `chats/{chatId}/messages/{messageId}`, renter `userChats`, owner `userChats` |
| `declineOverlappingBookings` | query over `assets/{assetId}/bookings` | matching asset bookings, matching user bookings when present, renter `userChats` when present |
| `syncUserMetadata` inactive | `users`, `users/{uid}/bookings`, `collectionGroup(bookings)`, `userChats/{uid}/chats` | same documents when stale |

### Document Ownership

| Data | Canonical write owner | Mirrors / side effects | Repair status |
|---|---|---|---|
| Booking request | `createBookingRequest` | asset booking, renter booking, chat root, user chat summaries, owner pending count | transactional callable write |
| Booking confirmation | `confirmBooking` | both booking mirrors, deterministic system chat, pending count decrement, overlap task enqueue | selected booking transactional; overlap cleanup async |
| Overlap decline | `declineOverlappingBookings` | asset booking, user booking when present, renter chat when present | structured partial results; missing optional mirrors no longer block asset decline |
| QR handover/return | `verifyAndMark` | both booking mirrors, deterministic events/messages, owner chat archive on return | valid retries are idempotent; no durable retry queue |
| Review closeout | `submitBookingReview` | rating doc, asset aggregate, both booking mirrors, renter chat archive | transactional review write; rating message cleanup follows transaction |
| User metadata snapshots | inactive `syncUserMetadata` design | booking and chat participant snapshots | not active; redesign or remove before relying on it |

### Data Model Implication

The backend duplicates booking state in two locations:

- asset-centric copy for inventory/availability logic
- user-centric copy for renter-facing views

This is common for mobile feed/query ergonomics, but it creates immediate consistency risk because every critical mutation must update both copies correctly every time.

## 5. Booking Engine Analysis

### Current Booking Flow

#### Booking Confirmation

Likely mobile flow:

1. User action triggers callable `confirmBooking`
2. Backend reads `assets/{assetId}/bookings/{bookingId}`
3. Transaction checks `status === "Pending"`
4. Backend updates both booking copies to `"Confirmed"`
5. Backend creates a system chat message
6. Backend updates renter and owner `userChats`
7. Backend attempts to enqueue overlap cleanup task
8. Client receives success immediately even if overlap cleanup later fails

Strength:

- Confirmation itself is server-side and transactional across the two booking copies plus chat metadata

Weakness:

- The overlap cleanup phase is not part of the same consistency boundary
- The async phase still needs emulator-backed coverage so authorization, retries, and mirror updates do not regress

### Overlap Prevention Model

The intended model is:

- confirm one selected booking immediately
- decline all overlapping pending bookings asynchronously

This is a reasonable scaling direction in principle. Large overlap fanout should not live inside the same Firestore transaction as the chosen confirmation.

The payload-contract bug between `confirmBooking` and `declineOverlappingBookings` has been fixed. The task now accepts the raw JSON payload that `confirmBooking` enqueues, and production requests are guarded with Cloud Tasks OIDC verification.

Remaining operational risk:

- overlap cleanup still happens outside the confirmation transaction
- task failures still need emulator-backed coverage and clearer operational reporting
- decline side effects are still intentionally narrower than confirmation side effects

### Status Lifecycle Actually Implemented

Implemented booking statuses found in code:

- `"Pending"`
- `"Confirmed"`
- `"HandedOver"`
- `"Returned"`
- `"Completed"`
- `"Declined"`
- `"Cancelled"`
- chat status `"Archived"`
- chat status `"archived"`

Unsupported product-brief aliases should not be used as persisted booking values:

- `ready_for_pickup`
- `active`
- `return_pending`
- lowercase lifecycle names

Conclusion:

The backend now enforces the canonical booking range contract through shared helpers and owns the critical lifecycle mutations used by the mobile app. `status` is the single persisted lifecycle state; QR tokens remain credentials only, and lifecycle events provide audit history.

## 6. QR / Token Trust System

### Current Design

Token payload fields:

- `bookingId`
- `userId`
- `assetId`
- `action`
- `uuid`
- `expiresAt`

Token format:

- base64 JSON payload
- `.` separator
- HMAC-SHA256 signature using `QR_SECRET`

Creation is centralized via `createSignedToken` in [`functions/utils/token.util.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/utils/token.util.js:6).

### Actual Trust Model by Function

#### `verifyToken`

This is the stronger validation path.

It checks:

- auth present
- signature valid
- payload decodes
- payload fields present
- not expired
- booking exists
- full presented token equals the stored Firestore token

This is good. It prevents stale or replaced tokens from passing validation.

#### `verifyAndMark`

This now tracks the read-only validation path much more closely.

It checks:

- auth present
- signature valid
- payload decodes
- fields present
- not expired
- booking exists
- booking has a `tokens` object
- full presented token equals the stored Firestore token
- caller is authorized for the specific QR action
- booking is in the correct lifecycle state
- action not already marked

Token parsing, signature validation, expiry checks, and completed-action checks now live in shared helpers used by both `verifyToken` and `verifyAndMark`.

### Remaining Trust Concern

The immediate verification gap between `verifyToken` and `verifyAndMark` has been closed. Future token semantics should continue to be covered at the shared helper level and, where practical, with callable-level tests.

### Token Expiry Concerns

`makeToken` and `regenerateToken` both compute:

- `handoverExpiry = endDate`
- `returnExpiry = endDate + 3 days`

Using `endDate` for handover expiry is suspicious. Handover usually occurs at or before booking start, not at booking end. This suggests either:

- the product semantics are different than the naming implies, or
- the token windows are wrong

## 7. Security Audit

### 1. Authorization Exists but Needs Coverage

The main callables now enforce participant or owner checks, and QR verification is action-scoped.

Remaining risk:
- those guarantees need emulator or function-level coverage so future edits do not silently weaken them

### 2. Caller-Controlled Identifiers Still Need Ongoing Validation

Critical paths now cross-check caller identity against booking or asset state, but the codebase still accepts multiple client-provided identifiers and therefore remains sensitive to any future missed validation path.

### 3. HTTP Task Endpoint Depends on OIDC Configuration

It now verifies OIDC bearer tokens in production and allows emulator traffic locally, but it still depends on correct service-account and audience configuration to remain locked down.

### 4. Internal Error Leakage

`confirmBooking` catches and rethrows `error.message` as an `internal` HttpsError in [`functions/calls/confirmBooking.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/confirmBooking.js:136).

This leaks raw internal failure text to clients and makes the public error contract unstable.

### 5. No Abuse Controls

There is no evidence of:

- App Check enforcement
- per-user rate limiting
- replay protection beyond token expiry and limited state checks
- audit correlation IDs
- admin override logging

## 8. Reliability Audit

### 1. Cloud Tasks Contract Is Fixed but Under-Tested

The payload shape and handler contract now align, and production requests require OIDC.

Remaining risk:
- there is still no automated coverage proving the enqueue path, OIDC assumptions, and overlap cleanup behavior stay aligned

### 2. Partial Side-Effect Failures After Booking Mutation

`verifyAndMark` commits booking mutation first, then sends chat messages, then runs another transaction to archive owner chat on return.

If a post-transaction chat write fails:

- booking state is mutated
- event logs are written
- UX messaging may be missing until the same valid QR action is retried

Lifecycle chat messages now use deterministic message IDs, and a repeated valid QR action is treated as a successful idempotent retry. There is still no durable retry queue for post-mutation side effects.

### 4. Misleading Function Result Contract

`confirmBooking` now reports `phase2: "enqueued"` or `phase2: "enqueue_failed"` depending on the Cloud Tasks enqueue result. Broader structured operational reporting is still thin.

### 5. Side-Effect Idempotency Is Partial

- `verifyAndMark` accepts repeat valid scans after a booking action is already marked
- core lifecycle chat messages are deduplicated by deterministic message IDs
- return flow emits multiple side effects without durable orchestration
- overlap decline retries depend on Cloud Tasks and still need automated coverage to stay reliable

### 6. Partial Mirror Repair Is Still Limited

`declineBooking` no longer requires every optional mirror to exist before declining the asset-side booking. It reports missing user booking and renter chat mirrors in structured results.

The remaining limitation is that it does not recreate missing mirrors or enqueue a repair job.

## 9. Scalability Audit

### What Is Reasonable

- Two-phase confirmation is a scalable direction
- Duplicated booking docs can be acceptable for mobile query efficiency if consistency is strictly controlled
- Async overlap fanout is better than loading many overlaps into one transaction

### What Will Break Under Load

#### 1. User Metadata Sync Design Is Full-Scan Heavy

If the commented scheduler is ever enabled as written, it will:

- scan all users
- run per-user booking queries
- run per-user collection group queries
- scan each user’s chats

That is not startup-scale fatal at tiny size, but it will become costly and slow quickly.

#### 2. Cold Start and Package Simplicity

The current codebase is small and unlikely to suffer severe cold start issues from code size alone. The bigger issue is not latency from code bulk; it is correctness and auth.

#### 3. No Clear Gen2 Strategy

The code uses `firebase-functions` `6.6.0`, but the implementation style remains older `functions.https.onCall` / `onRequest`. There is no evidence of concurrency tuning, region tuning, memory tuning, or Gen2-specific operational hardening.

## 10. Inconsistencies With Mobile App

This section is backend-inferred only. The mobile repository is not present here, so these are mismatch risks, not source-proven frontend bugs.

### Likely Contract Risks

#### 1. Status Casing Drift

Backend uses:

- `"Pending"`
- `"Confirmed"`
- `"HandedOver"`
- `"Returned"`
- `"Completed"`
- `"Declined"`
- `"Cancelled"`
- `"Archived"`

The product brief uses lowercase lifecycle names like `pending`, `confirmed`, `cancelled`, `completed`.

If the app expects lowercase enum values, this backend will drift.

#### 2. Scheduled Sync Expectations

The code comments describe a daily metadata sync design, but it is not deployed. If the app assumes automatic denormalized profile repair, that assumption is false today.

#### 3. Callable Surface Is Smaller Than Product Surface

The backend exports only:

- `createBookingRequest`
- `makeToken`
- `verifyAndMark`
- `regenerateToken`
- `verifyToken`
- `confirmBooking`
- `submitBookingReview`

If the mobile app expects backend-authoritative cancellation, payment confirmation, booking completion, admin moderation, or notifications, those functions do not exist in this repository.

## 11. Recommended Refactor Plan

### Priority 0: Fix Integrity Breakers Immediately

1. Extend automated coverage around task and callable authorization contracts.
2. Keep `verifyAndMark` and `verifyToken` on shared QR/token helpers whenever token or lifecycle semantics change.
3. Keep canonical booking range enforcement in shared helpers for any new lifecycle callable.

### Priority 1: Consolidate Booking State Authority

4. Normalize status casing and field naming if the product contract moves away from PascalCase values.
5. Keep duplicated booking docs if needed, but define one canonical write service and one schema contract.

### Priority 2: Harden Operational Reliability

8. Make function return payloads truthful about async outcomes.
9. Introduce structured logging with correlation IDs: bookingId, assetId, renterId, taskId, actorId.
10. Move post-transaction side effects into durable async jobs where partial failure matters.
11. Extend deterministic idempotency to any new chat-side business events.

### Priority 3: Lock Down Security Posture

12. Document production secret/config management instead of relying on implicit `.env` habits.
13. Add App Check or other abuse controls for callable access.

### Priority 4: Source-Control Backend Operations

14. Rework or remove `syncUserMetadata`; if kept, redesign it around targeted updates rather than full scans.

## 12. Future Production Blueprint

### Target Architecture

The backend should evolve into a startup-grade authoritative booking platform with these properties:

- backend-owned lifecycle transitions
- explicit role enforcement
- consistent booking schema
- durable async jobs for non-critical fanout
- strong observability and replay safety

### Recommended Direction

#### Authoritative Booking Service

Create one booking domain layer responsible for:

- creation
- confirmation
- cancellation
- handover
- activation
- return
- completion
- overlap resolution

No frontend should write critical lifecycle state directly.

#### Canonical Data Contract

Define:

- one booking status enum
- one event/audit model
- one token model
- one participant/role model

Then apply it consistently to both asset and user booking mirrors.

#### Secure Token System

Move from “signed payload only” to:

- signed payload
- stored current token/version
- role-based verifier authorization
- lifecycle precondition checks
- replay-safe event logging

#### Async Processing

Use Cloud Tasks or Pub/Sub intentionally:

- overlap cleanup
- notifications
- ratings prompts
- denormalized metadata repairs
- reminder workflows

Each async path should have:

- authenticated invocation
- idempotent handlers
- retry-safe payloads
- monitoring and alerting

#### Observability

Add:

- structured logs
- per-flow correlation IDs
- error classes
- metrics on booking transitions and task failures
- dead-letter or failure review workflow for async jobs

### CTO View

This backend is not a lost cause. It already centralizes some of the right responsibilities. But it is currently a prototype-grade authority layer, not a production-trustworthy one. The fastest path to maturity is not adding more features first. It is locking down authorization, fixing the overlap job contract, unifying lifecycle schema, and making the token mutation path trustworthy.
