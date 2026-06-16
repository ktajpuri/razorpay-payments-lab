'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const {
  verifyCheckoutSignature,
  verifyWebhookSignature,
} = require('../../server/signatures');

// Helper to forge a *valid* signature the way Razorpay would.
function makeCheckoutSig(orderId, paymentId, secret) {
  return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}
function makeWebhookSig(rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

test('checkout: valid signature passes', () => {
  const secret = 'test_secret';
  const sig = makeCheckoutSig('order_1', 'pay_1', secret);
  assert.strictEqual(
    verifyCheckoutSignature({ orderId: 'order_1', paymentId: 'pay_1', signature: sig, keySecret: secret }),
    true
  );
});

test('checkout: tampered signature fails (SCENARIO 1)', () => {
  const secret = 'test_secret';
  const sig = makeCheckoutSig('order_1', 'pay_1', secret);
  const tampered = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a');
  assert.strictEqual(
    verifyCheckoutSignature({ orderId: 'order_1', paymentId: 'pay_1', signature: tampered, keySecret: secret }),
    false
  );
});

test('checkout: signature from a different secret fails', () => {
  const sig = makeCheckoutSig('order_1', 'pay_1', 'attacker_secret');
  assert.strictEqual(
    verifyCheckoutSignature({ orderId: 'order_1', paymentId: 'pay_1', signature: sig, keySecret: 'real_secret' }),
    false
  );
});

test('webhook: valid signature over raw body passes', () => {
  const secret = 'whsec';
  const raw = Buffer.from(JSON.stringify({ event: 'payment.captured' }));
  const sig = makeWebhookSig(raw, secret);
  assert.strictEqual(verifyWebhookSignature({ rawBody: raw, signature: sig, webhookSecret: secret }), true);
});

test('webhook: invalid signature fails (SCENARIO 9)', () => {
  const secret = 'whsec';
  const raw = Buffer.from(JSON.stringify({ event: 'payment.captured' }));
  assert.strictEqual(
    verifyWebhookSignature({ rawBody: raw, signature: 'deadbeef', webhookSecret: secret }),
    false
  );
});

test('webhook: re-serialized body breaks signature (why we keep raw bytes)', () => {
  const secret = 'whsec';
  const original = '{"event":"payment.captured","x":1}';
  const sig = makeWebhookSig(Buffer.from(original), secret);
  // Re-serializing parsed JSON reorders/space-changes bytes -> signature breaks.
  const reSerialized = Buffer.from(JSON.stringify(JSON.parse(original)));
  // (In this particular string they may match; assert the principle holds for spaced input.)
  const spaced = '{ "event": "payment.captured", "x": 1 }';
  const spacedReser = Buffer.from(JSON.stringify(JSON.parse(spaced)));
  const spacedSig = makeWebhookSig(Buffer.from(spaced), secret);
  assert.strictEqual(verifyWebhookSignature({ rawBody: spacedReser, signature: spacedSig, webhookSecret: secret }), false);
});
