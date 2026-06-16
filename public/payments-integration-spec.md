# Payments Integration — Learning Spec (Phase 1)

## Goal

Integrate a one-time payment flow against a real payment gateway (Razorpay, test mode) and **experience every failure mode first-hand**. The deliverable is not a product — it is a working flow plus a *proven* failure matrix where each bad path lands in a correct, observable state.

The point is comprehension, not an artifact. Success = "I can explain and demonstrate idempotency, async finalization, and the order lifecycle because I made each one happen and watched it."

## Non-goals (explicit scope box)

These are deliberately excluded. If I find myself building any of these, I've drifted into comfortable work that teaches nothing about payments:

- No real authentication / user management — a hardcoded `user_id` is fine.
- No catalog, search, or browse — **one hardcoded product**.
- No styling beyond bare functional HTML. No design.
- No subscriptions / mandates / autopay — that is **Phase 2**, decided after Phase 1 is green.
- No production hardening beyond what the failure matrix requires (no real secrets management, no multi-env pipeline).
- No real money. Everything runs in **test mode**.

## Stack

- **Backend:** Node + Express. Razorpay Node SDK.
- **Frontend:** Minimal React (or even a single static HTML page — checkout is a hosted widget, so the client is thin).
- **Store:** SQLite (or a single JSON file / in-memory map). The store exists only to hold order state and prove idempotency; it does not need to be "good."
- **Gateway:** Razorpay Standard Checkout, **Test Mode only**.
- **Tunnel:** ngrok (or similar) to expose the local webhook endpoint to Razorpay.

## The flow (what actually happens)

```
[Client]                [Server]                    [Razorpay]
   |  click "Pay"  -------->|                            |
   |                        |  create Order ------------>|
   |                        |<--------- order_id --------|
   |<------ order_id -------|                            |
   |  open Checkout(order_id) --------------------------->|
   |                  (user pays on hosted widget)        |
   |<---- razorpay_payment_id, order_id, signature -------|
   |  POST /verify -------->|                            |
   |                        |  verify signature (HMAC)   |
   |                        |  -> provisional state       |
   |                        |                            |
   |        ... asynchronously ...                       |
   |                        |<--- webhook: payment.* -----|  (SOURCE OF TRUTH)
   |                        |  verify webhook sig         |
   |                        |  -> finalize state          |
```

**Two rules that define the whole design:**

1. **Never trust the client.** The browser callback is *provisional*. Fulfilment decisions are made server-side, gated on signature verification and the webhook.
2. **The webhook is the source of truth**, not the callback. The callback may never arrive (closed tab); the webhook may arrive first, twice, or out of order. The server must be correct under all of these.

## Order state machine

| State | Meaning | Entered by |
|---|---|---|
| `CREATED` | Order created server-side, awaiting payment | server, on `/create-order` |
| `AUTHORIZED` | Payment authorized, not yet captured (manual-capture path only) | `payment.authorized` webhook |
| `PAID` | Captured and confirmed — **terminal success** | `payment.captured` webhook |
| `FAILED` | Payment failed at gateway — **terminal** | `payment.failed` webhook |
| `ABANDONED` | No resolution within timeout — **terminal**, set by sweeper | background sweep |
| `REFUNDED` | Refund issued — **terminal** | refund flow / `refund.processed` |

The provisional `/verify` callback may *optimistically* mark a row, but only a webhook moves it to a terminal money state. Every order must end in exactly one terminal state. Zero rows left dangling in `CREATED`/`AUTHORIZED` forever — that's what the sweeper enforces.

## The failure matrix (the heart of this project)

For each row: **trigger it deliberately, observe the result, confirm the expected behavior.** This table *is* the learning outcome.

| # | Scenario | How to trigger (test mode) | Correct behavior |
|---|---|---|---|
| 1 | **Forged / tampered signature** | POST `/verify` with a wrong `razorpay_signature` (edit it by hand / curl) | Reject. Do **not** mark paid, do not fulfil. Log and 400. This is the security lesson. |
| 2 | **Duplicate webhook** | Replay the same webhook payload twice (re-send from ngrok inspector or curl) | Idempotency guard: second delivery is a no-op. **No double-fulfil.** Keyed on `(order_id)` / event id. |
| 3 | **Callback never arrives, webhook does** | Complete payment, then *close the tab* before `/verify` returns | Order still reaches `PAID` via webhook alone. Proves webhook is source of truth. |
| 4 | **Webhook arrives before callback** | Add an artificial delay in `/verify`; let the webhook land first | Final state correct regardless of order. No assumption that callback precedes webhook. |
| 5 | **Payment fails at gateway** | Use UPI VPA `failure@razorpay`, or the **Failure** button on the mock bank page | Order → `FAILED` cleanly. User sees failure. No stuck `PENDING`. |
| 6 | **User abandons checkout** | Open checkout, close it without paying | Order stays `CREATED`, then sweeper marks `ABANDONED` after timeout. No orphan. |
| 7 | **Authorized but not captured** | Set Razorpay to **manual capture**; authorize a payment, don't capture | Order sits in `AUTHORIZED`. Confirm Razorpay auto-refunds uncaptured payments after its fixed window. Capture decision made explicit. |
| 8 | **Refund** | Trigger a refund via API/dashboard on a `PAID` order | Order → `REFUNDED` via refund webhook. At least stubbed end-to-end. |
| 9 | **Bad webhook signature** | Send a webhook with an invalid `X-Razorpay-Signature` | Reject — do not process. Webhook auth is *separate* from checkout signature (different secret). |

Triggers grounded in Razorpay test mode: the mock bank page has explicit Success/Failure buttons; `success@razorpay` / `failure@razorpay` force UPI outcomes; test events fire on any test-mode transaction with the same payload shape as live; webhooks are documented to sometimes arrive out of order (scenario 4 is real, not contrived).

## Testing

**Unit tests** (pure logic, no network):
- Signature verification — valid passes, tampered fails (scenario 1).
- Webhook signature verification — valid vs invalid (scenario 9).
- Idempotency guard — second identical event is a no-op (scenario 2).
- State machine transitions — only legal transitions allowed; illegal ones rejected (e.g. `PAID` → `CREATED` is impossible).
- Amount / currency validation on order creation.

**E2E tests** (against test mode):
- Full happy path: create → checkout → verify → webhook → `PAID`.
- Each failure-matrix row driven and asserted on the resulting terminal state.
- The two race conditions (3 and 4) — the highest-value tests, because they're the ones intuition gets wrong.

The failure tests are the deliverable. The happy path is trivial; the value is proving every bad path lands correctly.

## Environment & setup

- **Test Mode only.** Generate Test API keys (instant, no KYC). `key_id` + `key_secret` + a **webhook secret** (separate).
- Keys live in environment variables / `.env` (gitignored). Never committed, never logged.
- Webhook endpoint needs a public URL → run ngrok, register the ngrok URL in the Razorpay dashboard webhook settings, subscribe to `payment.authorized`, `payment.captured`, `payment.failed`, `refund.processed`.
- There is **no separate staging gateway** — test mode *is* staging. Going live (out of scope here) would be a one-time key swap plus a single real smoke transaction.

## Build sequence

1. Project scaffold: Express server, minimal client, SQLite/JSON store, `.env`.
2. `POST /create-order` → Razorpay Orders API → persist row as `CREATED` → return `order_id`.
3. Client: one "Pay" button → open Checkout with `order_id` → handle success/dismiss.
4. `POST /verify` → checkout signature verification → provisional state update.
5. `POST /webhook` → webhook signature verification → **idempotent** handler → finalize state machine.
6. Background sweeper → mark stale `CREATED` orders `ABANDONED`.
7. Refund stub → `REFUNDED` path.
8. Walk the **entire failure matrix** by hand, confirming each terminal state.
9. Write unit + e2e tests covering happy path + every failure row.

## Definition of done (Phase 1)

- [ ] Happy path works end-to-end against test mode.
- [ ] All 9 failure-matrix rows triggered by hand and confirmed landing in the correct terminal state.
- [ ] Idempotency proven (scenario 2) — duplicate webhook does not double-fulfil.
- [ ] Webhook-as-source-of-truth proven (scenario 3) — works with the tab closed.
- [ ] Unit + e2e tests green, covering happy path and every failure row.
- [ ] I can verbally explain, from having watched it: idempotency → exactly-once *effect*, trigger-then-webhook-finalize, and the order lifecycle.

When this checklist is done, **stop.** Subscriptions (Phase 2) is a separate decision, not a momentum continuation.
