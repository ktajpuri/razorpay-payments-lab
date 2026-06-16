# Razorpay Payments Lab

A focused, single-purpose integration that does one thing well: take a one-time
payment through a real gateway (Razorpay) and **prove that every failure mode
lands in a correct, terminal state.**

This is not a store. There is one hardcoded product and one button. The value is
not the happy path — that's trivial — it's the **failure matrix** and the tests
that back it. The interesting engineering in payments is what happens when things
go wrong: tampered callbacks, duplicate webhooks, a user closing the tab
mid-payment, events arriving out of order. This repo makes each of those happen
on purpose and shows the system staying correct.

## What it demonstrates

- **Server-authoritative payments** — amounts are created server-side; the client
  is never trusted. The browser callback is treated as *provisional*; the webhook
  is the source of truth.
- **Exactly-once *effect* via idempotency** — webhooks are at-least-once. An atomic
  idempotency guard (a `UNIQUE` constraint, not a read-modify-write) ensures a
  duplicate delivery never double-fulfils.
- **An explicit order state machine** — legal transitions are encoded in one place;
  illegal ones (e.g. `PAID → CREATED`, a late `authorized` regressing a `captured`)
  are rejected by construction.
- **Asynchronous finalization** — the worker/handler split mirrors how real money
  rails behave: you initiate, then a separate webhook path finalizes.
- **A "zero dangling orders" guarantee** — a sweeper gives every abandoned order a
  terminal state, which is the precondition for reconciliation.

## The failure matrix

Each row is triggered deliberately and asserted on. This table is the deliverable.

| # | Scenario | Trigger (test mode) | Correct outcome |
|---|---|---|---|
| 1 | Forged checkout signature | POST `/verify` with a wrong signature | Rejected (400), order stays `CREATED` |
| 2 | Duplicate webhook | Replay the same event id | No-op, no double-fulfil |
| 3 | Callback never arrives | Close the tab after paying | Order still reaches `PAID` via webhook |
| 4 | Out-of-order webhooks | `captured` before `authorized` | No state regression |
| 5 | Gateway failure | UPI `failure@razorpay` / mock-bank Failure button | Order → `FAILED` |
| 6 | Abandoned checkout | Dismiss the widget | Order → `ABANDONED` by sweeper |
| 7 | Authorized, not captured | Manual-capture mode, don't capture | Stays `AUTHORIZED`; gateway auto-refunds |
| 8 | Refund | `POST /refund/:orderId` on a paid order | Order → `REFUNDED` |
| 9 | Forged webhook signature | Bad `X-Razorpay-Signature` | Rejected (400) |

Rows 1, 2, 4, 5, 9 are covered by automated tests. Rows 3, 6, 7, 8 are driven by
hand against test mode — see [`COMPANION.md`](./COMPANION.md).

## Architecture

```
Client (one button)         Server                         Razorpay (test mode)
  POST /create-order  ─────► orders.createOrder ──────────► Orders API
  open Checkout(order_id) ─────────────────────────────────► hosted widget
  handler() POST /verify ──► verify.js  (PROVISIONAL: signature only)
                             webhook.js (AUTHORITATIVE) ◄──── payment.* webhook
                               ├─ verify signature
                               ├─ idempotency guard (UNIQUE event id)
                               └─ state machine apply
  GET /orders/:id     ─────► inspect terminal state
```

Modules map one-to-one to concepts: `signatures.js` (security boundary),
`stateMachine.js` (lifecycle), `store.js` (durable state + atomic idempotency),
`webhook.js` (source of truth), `verify.js` (provisional callback),
`sweeper.js` (terminal-state guarantee).

## Run it

```bash
npm install
cp .env.example .env        # fill in Razorpay TEST keys
npm test                    # unit tests — no keys needed, all green
npm start                   # server on :3000
# expose the webhook so Razorpay can reach it:
#   ngrok http 3000   -> register the URL in Dashboard > Settings > Webhooks
npm run test:e2e            # gateway tests (needs keys + running server)
```

Test keys are instant (no KYC). Everything here runs in **test mode** — no real
money moves. There is no separate staging gateway; test vs live is just which key
set you load.

## Test status

Unit suite: **17 tests, green**, covering signature verification (valid / tampered
/ wrong-secret / raw-body), the full state-machine transition table, and the
idempotency guard including the out-of-order case.

## Scope, on purpose

No auth, no catalog, no styling, no subscriptions. Those teach nothing about
payment correctness and were deliberately excluded. Subscriptions (UPI mandates,
AFA, dunning) are a genuinely different system and are out of scope for this lab.

## License

MIT.
