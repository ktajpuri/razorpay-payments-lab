'use strict';

/**
 * e2e flow tests — these talk to the REAL Razorpay test-mode API and your running
 * server, so they are SKIPPED unless RAZORPAY_KEY_ID is set. They are the
 * machine-checkable half of the failure matrix; the other half (closing the tab,
 * the mock-bank Failure button) is driven by hand in the browser — see COMPANION.md.
 *
 * Run with test keys loaded:  npm run test:e2e
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const HAS_KEYS = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const BASE = process.env.BASE_URL || 'http://localhost:3000';

describe('e2e (requires test keys + running server)', { skip: !HAS_KEYS && 'set RAZORPAY_KEY_ID to run' }, () => {
  test('create-order returns a Razorpay order in CREATED state', async () => {
    const res = await fetch(`${BASE}/create-order`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const order = await res.json();
    assert.match(order.id, /^order_/);
    assert.strictEqual(order.amount, 50000);

    const stateRes = await fetch(`${BASE}/orders/${order.id}`);
    const stored = await stateRes.json();
    assert.strictEqual(stored.status, 'CREATED');
  });

  test('forged checkout signature is rejected (SCENARIO 1)', async () => {
    const orderRes = await fetch(`${BASE}/create-order`, { method: 'POST' });
    const order = await orderRes.json();

    const res = await fetch(`${BASE}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: order.id,
        razorpay_payment_id: 'pay_forged',
        razorpay_signature: 'totally_made_up',
      }),
    });
    assert.strictEqual(res.status, 400);
    // Order must NOT have advanced.
    const stored = await (await fetch(`${BASE}/orders/${order.id}`)).json();
    assert.strictEqual(stored.status, 'CREATED');
  });

  test('webhook with bad signature is rejected (SCENARIO 9)', async () => {
    const res = await fetch(`${BASE}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Razorpay-Signature': 'invalid',
        'X-Razorpay-Event-Id': 'evt_e2e_bad',
      },
      body: JSON.stringify({ event: 'payment.captured' }),
    });
    assert.strictEqual(res.status, 400);
  });

  // NOTE: a full happy-path e2e (real captured payment) requires either the
  // browser checkout step or Razorpay's test-payment API + a tunnelled webhook.
  // The COMPANION walks the manual version; automating it fully is an optional
  // stretch once the manual matrix is green.
});
