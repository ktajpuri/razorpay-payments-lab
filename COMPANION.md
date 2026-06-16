# Companion — Build Sequence & What to Understand at Each Step

This is the document that makes the repo a learning exercise rather than a thing
you skim. Work the steps in order. At each one there is a **build** action, a
**concept** to internalize, and a **prove-it** action where you make the behavior
happen with your own hands. The repo gives you the scaffold; the understanding
comes from the prove-it steps and from reading the *why* in each module's comment.

A note before you start: the goal isn't to memorize Razorpay's API. It's to come
away able to reason about three things — **idempotency → exactly-once effect**,
**trigger-then-webhook-finalize**, and **the order lifecycle** — from having
watched them. If you can explain those three to someone else afterwards, the lab
worked.

---

## Step 0 — Get the gateway reachable

**Build:** Generate test keys (Dashboard → API Keys → Test Mode). Copy
`.env.example` to `.env`, fill them in. `npm install`, `npm start`.

**Concept:** There is no "staging Razorpay." There is test mode and live mode,
distinguished only by which key set you load. Everything in this lab — every
failure — is reproducible in test mode with no real money. That fact is the whole
reason payment integrations are testable at all, and it's exactly the thing that
was *missing* at Flipkart-scale where real orders had to be placed. Razorpay's
test mode is the industry's answer to "external rails have no sandbox."

**Prove it:** Hit `http://localhost:3000`. You should see one product and one
button. Nothing works end-to-end yet — that's expected.

---

## Step 1 — Create an order (server-authoritative)

**Build:** `POST /create-order` is already wired to `orders.createOrder`. Read
`orders.js`.

**Concept:** The amount is decided **on the server**, in paise, and sent to
Razorpay's Orders API. The client never says "charge ₹500" — if it could, a user
could edit it to ₹1. This is the first and most basic payments principle: the
client is an untrusted input device. The `order_id` Razorpay returns is the join
key between your ledger and theirs for the entire lifecycle.

**Prove it:** Click Pay. Watch the log show `order created: order_...`. Then
`GET /orders/<that id>` and confirm it's `CREATED` in your own store. You now have
two records of the same order — yours and Razorpay's — which is the seed of why
reconciliation exists.

---

## Step 2 — Open Checkout and verify the callback (the PROVISIONAL path)

**Build:** The client opens the hosted widget with the `order_id`. On success it
POSTs the response to `/verify`. Read `verify.js` and `signatures.js`
(`verifyCheckoutSignature`).

**Concept — this is the subtle one.** The browser callback gives you
`order_id`, `payment_id`, and a signature. You verify the signature
(`HMAC-SHA256(order_id|payment_id)` with your key secret) to prove the callback
wasn't tampered with. **But you do not mark the order PAID here.** The callback is
*provisional* — it can be forged (scenario 1), and more importantly it may never
fire at all if the user closes the tab. Treating the callback as truth is the
canonical beginner bug in payments. Verify it, then wait for the webhook.

**Prove it (SCENARIO 1):** With the server running, forge a bad callback:
```bash
curl -s -X POST localhost:3000/verify -H 'Content-Type: application/json' \
  -d '{"razorpay_order_id":"order_x","razorpay_payment_id":"pay_x","razorpay_signature":"fake"}'
```
You get a 400 and the order does not advance. You just watched the security
boundary hold.

---

## Step 3 — The webhook (the AUTHORITATIVE path)

**Build:** `POST /webhook` uses a **raw** body parser, verifies the webhook
signature (different secret!), runs the idempotency guard, then applies the event
through the state machine. Read `webhook.js` top to bottom — the ordering of those
three steps is deliberate.

**Concept — the heart of the lab.** Three real-world conditions, three defenses:

- **Untrusted caller** → signature verification. Anyone can POST to this URL.
  Note it uses the *raw bytes*: re-serializing parsed JSON changes the bytes and
  breaks the signature. (There's a unit test that proves exactly this.)
- **Duplicate delivery** → idempotency guard. Webhooks are *at-least-once*. The
  guard is an atomic `INSERT` of the event id with a `UNIQUE` constraint — if the
  insert fails, we've seen it, so we no-op. This is the precise mechanism behind
  the sentence "you don't get exactly-once *delivery*; you get at-least-once plus
  idempotency, which composes to exactly-once *effect*." Say that sentence until
  it's yours — it's the one that reads as senior.
- **Out-of-order delivery** → state-machine guards. `captured` can arrive before
  `authorized`. A late `authorized` must not regress a `PAID` order. The lifecycle
  rules in `stateMachine.js` make that impossible by construction.

**Prove it (SCENARIO 2 — idempotency):** The unit test already proves the guard,
but watch it live too. After a real test payment, find the event in the ngrok
inspector and **resend it**. The second delivery returns `duplicate-ignored` and
the order doesn't change. That's a double-charge that didn't happen.

**Prove it (SCENARIO 9 — forged webhook):**
```bash
curl -s -X POST localhost:3000/webhook -H 'Content-Type: application/json' \
  -H 'X-Razorpay-Signature: nope' -H 'X-Razorpay-Event-Id: e1' \
  -d '{"event":"payment.captured"}'
```
400, rejected before any processing.

---

## Step 4 — Watch the async finalization end-to-end

**Build:** Run `ngrok http 3000`, register the URL under Dashboard → Settings →
Webhooks, subscribe to `payment.authorized`, `payment.captured`,
`payment.failed`, `refund.processed`.

**Concept:** This is "trigger-then-webhook-finalize" made visible. The browser
callback and the webhook are two separate paths, and the webhook is the one that
moves money state. Internalizing this is the exact gap that showed up when you
described a synchronous success/failure branch in the interview — UPI and card
debits don't hand you the final answer synchronously; the answer arrives later, by
webhook.

**Prove it (SCENARIO 3 — the one that fixes the mental model):** Start a payment,
complete it on the mock bank page, and **close the browser tab before `/verify`
finishes.** The callback never lands. Then `GET /orders/<id>` — it's `PAID`
anyway, because the webhook finalized it. This single experiment is worth more
than any amount of reading; do it deliberately and notice what it teaches.

---

## Step 5 — Failure and abandonment (terminal states for everything)

**Concept:** Every order must end somewhere. An order that's neither paid nor
explicitly failed nor abandoned is a reconciliation break waiting to happen.

**Prove it (SCENARIO 5 — gateway failure):** Pay using UPI id `failure@razorpay`,
or click the **Failure** button on the mock bank page. The order lands `FAILED`,
cleanly, no stuck pending.

**Prove it (SCENARIO 6 — abandonment):** Open Checkout, close it without paying.
The order stays `CREATED`. Lower `ABANDON_AFTER_MS` in `.env` to something small,
restart, and watch the sweeper log mark it `ABANDONED`. That sweep is the humble
job that makes "zero dangling orders" true — which is the precondition for the
reconciliation function you saw as a whole standing team at Flipkart.

---

## Step 6 — Capture mode and refunds

**Prove it (SCENARIO 7 — authorized vs captured):** In the Dashboard, switch off
auto-capture. Make a payment. It authorizes but doesn't capture — your order sits
`AUTHORIZED`. Confirm via the Dashboard that Razorpay auto-refunds uncaptured
payments after its window. The lesson: authorization ≠ settlement, and an
uncaptured payment is money you haven't actually taken.

**Prove it (SCENARIO 8 — refund):** On a `PAID` order, `POST /refund/<orderId>`.
The `refund.processed` webhook moves it to `REFUNDED`. Notice the refund is itself
async and finalized by webhook — the same pattern, again.

---

## Step 7 — Read the tests as the specification

Run `npm test` and read the three unit files. They aren't an afterthought; they're
the executable statement of what "correct" means here. The failure tests are the
point — the happy path is one line. When you can look at `idempotency.test.js` and
predict every assertion before running it, you understand the system.

---

## When you're done

You should be able to say, from direct experience and without notes:

1. Why the client is never trusted and the callback is only provisional.
2. Why idempotency gives exactly-once *effect* despite at-least-once delivery, and
   why the guard is a `UNIQUE` insert rather than a check-then-write.
3. Why the webhook — not the callback — is the source of truth, and what happens
   when it arrives late, twice, or out of order.
4. Why every order needs a terminal state, and how that connects to reconciliation.

That's the whole lesson. **Then stop.** Subscriptions are a separate, larger
system (mandates, AFA, the ₹15k cap, pre-debit notifications, dunning) and a
separate decision — not a momentum continuation of this lab. If you choose to do
it, choose it deliberately, not because the build was fun and you don't want to
stop.
