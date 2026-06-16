'use strict';

/**
 * signatures.js — the security boundary.
 *
 * Two DIFFERENT signatures, two DIFFERENT secrets. Conflating them is a common
 * mistake:
 *
 *   1. Checkout signature   — proves the browser callback wasn't tampered with.
 *      HMAC-SHA256( order_id + "|" + payment_id ) keyed with the API KEY SECRET.
 *
 *   2. Webhook signature     — proves the server-to-server webhook is really from
 *      Razorpay. HMAC-SHA256( raw_request_body ) keyed with the WEBHOOK SECRET.
 *
 * Both comparisons use timingSafeEqual to avoid leaking information through
 * comparison timing. A failed check is never "probably fine" — it is rejected.
 */

const crypto = require('crypto');

function safeEqualHex(a, b) {
  const bufA = Buffer.from(a || '', 'utf8');
  const bufB = Buffer.from(b || '', 'utf8');
  // timingSafeEqual throws if lengths differ, so guard first.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify the signature returned to the browser by Checkout on success.
 * Returns true only if the signature is valid for this order+payment.
 */
function verifyCheckoutSignature({ orderId, paymentId, signature, keySecret }) {
  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return safeEqualHex(expected, signature);
}

/**
 * Verify a webhook. MUST be given the RAW request body (the exact bytes
 * Razorpay sent) — re-serializing parsed JSON will change the bytes and break
 * the signature. That is why the webhook route uses a raw body parser.
 */
function verifyWebhookSignature({ rawBody, signature, webhookSecret }) {
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');
  return safeEqualHex(expected, signature);
}

module.exports = { verifyCheckoutSignature, verifyWebhookSignature, safeEqualHex };
