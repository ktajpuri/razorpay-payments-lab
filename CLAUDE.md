# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
cp .env.example .env      # fill in Razorpay TEST keys before starting
npm start                  # server on :3000 (default)
npm test                   # unit tests only — no keys needed
npm run test:unit          # same as npm test
npm run test:e2e           # gateway tests — requires keys + running server + ngrok webhook
```

Tests use Node's built-in `node:test` runner (no Jest/Mocha). Run a single test file directly:

```bash
node --test test/unit/stateMachine.test.js
```

For e2e/manual scenarios, expose the webhook with `ngrok http 3000` and register the URL in Razorpay Dashboard > Settings > Webhooks.

## Environment

Copy `.env.example` to `.env`. Required keys:

| Variable | Source |
|---|---|
| `RAZORPAY_KEY_ID` | Dashboard → API Keys → Test Mode |
| `RAZORPAY_KEY_SECRET` | Same place — **API key secret** (not webhook secret) |
| `RAZORPAY_WEBHOOK_SECRET` | Dashboard → Settings → Webhooks → secret set at creation |
| `PORT` | Optional, defaults to 3000 |
| `DB_PATH` | Optional, defaults to `./payments.db` |
| `ABANDON_AFTER_MS` | Optional, defaults to 900000ms; lower it to test the sweeper fast |

`RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` are **two different secrets** — conflating them is a common mistake and the signatures module enforces the distinction explicitly.

## Architecture

The flow has two paths after the user pays: a *provisional* browser callback and an *authoritative* webhook. Only the webhook moves order state to terminal.

```
Client (browser)            Server                         Razorpay
POST /create-order   ──►  orders.js ──────────────────►  Orders API (amount fixed server-side)
open Checkout(order_id) ──────────────────────────────►  hosted widget
handler() POST /verify ──►  verify.js (signature check only — does NOT mark PAID)
                            webhook.js (source of truth) ◄── payment.* / refund.* events
                              1. verifyWebhookSignature (raw bytes)
                              2. markEventProcessed (atomic UNIQUE insert)
                              3. applyEvent via state machine
GET /orders/:id      ──►  store.getOrder (inspect terminal state)
```

### Module responsibilities

| File | Role |
|---|---|
| `server/signatures.js` | Security boundary — two HMAC-SHA256 functions, timing-safe comparison |
| `server/stateMachine.js` | Order lifecycle — legal transitions table, `stateForEvent` mapping |
| `server/store.js` | SQLite via `better-sqlite3` — durable state + atomic idempotency guard |
| `server/webhook.js` | Authoritative handler — signature → idempotency → state machine (order matters) |
| `server/verify.js` | Provisional callback — signature check only, does not advance state to PAID |
| `server/sweeper.js` | Background timer — marks stale `CREATED` orders `ABANDONED` |
| `server/orders.js` | Calls Razorpay Orders API, inserts `CREATED` row into store |
| `server/razorpayClient.js` | Lazy Razorpay SDK client, exports key constants |
| `server/index.js` | Express wiring — webhook route mounts `express.raw()` **before** `express.json()` |

### Key invariants

**Webhook handler ordering is not negotiable.** In `webhook.js`, the three steps run in sequence: signature verification → idempotency guard → state application. Reordering them breaks security or correctness.

**Raw body for webhook signatures.** The `/webhook` route uses `express.raw()` so `req.body` is the exact `Buffer` Razorpay signed. If you parse then re-serialize JSON, the bytes change and the signature check fails. The test `webhook: re-serialized body breaks signature` proves this.

**Idempotency is a `UNIQUE` constraint, not a read-then-write.** `store.markEventProcessed` does a single `INSERT`; a duplicate event id throws `SQLITE_CONSTRAINT_PRIMARYKEY` which is caught and returns `false`. A check-first approach has a race window; the constraint does not.

**State machine is append-only for terminals.** `PAID`, `FAILED`, `ABANDONED`, `REFUNDED` have no outgoing edges except `PAID → REFUNDED`. A late or out-of-order webhook cannot regress an order.

### Database schema

Two tables in SQLite (WAL mode):
- `orders` — one row per order, `status` tracks the lifecycle state
- `processed_events` — idempotency ledger; `event_id` is the primary key (`X-Razorpay-Event-Id` header)

`store._reset()` clears both tables — used in tests.

## Test structure

```
test/unit/
  signatures.test.js    — HMAC verification (valid / tampered / wrong-secret / raw-body)
  stateMachine.test.js  — all legal and illegal transitions
  idempotency.test.js   — duplicate guard + out-of-order webhook scenario
test/e2e/
  flow.test.js          — gateway tests against live test mode
```

Unit tests cover scenarios 1, 2, 4, 5, 9 from the failure matrix. Scenarios 3, 6, 7, 8 require manual interaction against a running server.
