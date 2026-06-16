'use strict';

/**
 * webhook.js — the source of truth.
 *
 * The browser callback is provisional and may never arrive (closed tab). The
 * webhook is what actually moves money state. This handler must be correct under
 * three real-world conditions Razorpay explicitly warns about:
 *
 *   - Duplicates: the same event can be delivered more than once.  -> idempotency guard
 *   - Out-of-order: payment.captured may arrive before payment.authorized. -> state machine guards
 *   - Untrusted callers: anyone can POST to this URL.               -> signature verification
 *
 * Order of operations matters: verify signature -> idempotency guard -> apply.
 */

const store = require('./store');
const { verifyWebhookSignature } = require('./signatures');
const { stateForEvent, canTransition, isTerminal } = require('./stateMachine');

/**
 * Apply one verified, de-duplicated webhook event to order state.
 * Pure-ish: takes the parsed body, returns a short result describing what happened.
 */
function applyEvent(body) {
  const event = body.event;
  const target = stateForEvent(event);
  if (!target) return { action: 'ignored', reason: `no mapping for ${event}` };

  // Pull the payment/refund entity to find our order_id.
  const entity =
    body.payload?.payment?.entity ||
    body.payload?.refund?.entity ||
    null;
  const orderId = entity?.order_id;
  const paymentId = entity?.id && body.payload?.payment ? entity.id : entity?.payment_id;

  if (!orderId) return { action: 'ignored', reason: 'no order_id in payload' };

  const order = store.getOrder(orderId);
  if (!order) return { action: 'ignored', reason: `unknown order ${orderId}` };

  // State machine guard. If the transition is illegal (e.g. an out-of-order
  // authorized arriving after captured, or a duplicate that slipped the id guard),
  // we DO NOT force it. Already-terminal-correct states are left alone.
  if (order.status === target) {
    return { action: 'noop', reason: `already ${target}` };
  }
  if (isTerminal(order.status) && !(order.status === 'PAID' && target === 'REFUNDED')) {
    return { action: 'noop', reason: `already terminal (${order.status})` };
  }
  if (!canTransition(order.status, target)) {
    return { action: 'rejected', reason: `illegal ${order.status} -> ${target}` };
  }

  store.updateOrder(orderId, { status: target, payment_id: paymentId });
  return { action: 'applied', from: order.status, to: target, orderId };
}

/**
 * Express handler. Mounted with a RAW body parser so signature verification sees
 * the exact bytes Razorpay sent.
 */
function handleWebhook(webhookSecret) {
  return function (req, res) {
    const signature = req.headers['x-razorpay-signature'];
    const eventId = req.headers['x-razorpay-event-id'];
    const rawBody = req.body; // Buffer, thanks to express.raw()

    // 1. Authenticate the caller.
    const ok = verifyWebhookSignature({ rawBody, signature, webhookSecret });
    if (!ok) {
      // Untrusted / tampered. Reject without processing.
      return res.status(400).json({ error: 'invalid webhook signature' });
    }

    // 2. Idempotency. Insert the event id; if it already existed, this is a
    //    redelivery — acknowledge 200 but do nothing.
    if (eventId && !store.markEventProcessed(eventId)) {
      return res.status(200).json({ status: 'duplicate-ignored' });
    }

    // 3. Apply.
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'invalid json' });
    }

    const result = applyEvent(body);

    // Always 200 on a verified, non-duplicate event we understood — even a
    // legitimate no-op — so Razorpay stops retrying. A 5xx here would cause
    // (correct) redelivery, which our idempotency guard would then absorb.
    return res.status(200).json(result);
  };
}

module.exports = { applyEvent, handleWebhook };
