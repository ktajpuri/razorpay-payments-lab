'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// Use a throwaway DB file for tests.
process.env.DB_PATH = path.join(__dirname, 'test-idempotency.db');
function cleanDb() {
  for (const ext of ['', '-wal', '-shm']) {
    const f = process.env.DB_PATH + ext;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}
cleanDb();

const store = require('../../server/store');
const { applyEvent } = require('../../server/webhook');

beforeEach(() => store._reset());

function capturedEvent(orderId, paymentId) {
  return {
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, order_id: orderId } } },
  };
}

test('idempotency guard: first event id is new, second is duplicate (SCENARIO 2)', () => {
  assert.strictEqual(store.markEventProcessed('evt_1'), true);  // first time
  assert.strictEqual(store.markEventProcessed('evt_1'), false); // duplicate
  assert.strictEqual(store.markEventProcessed('evt_2'), true);  // different event
});

test('applying captured event moves CREATED -> PAID', () => {
  store.createOrder({ id: 'order_A', receipt: 'r', amount: 50000, currency: 'INR' });
  const result = applyEvent(capturedEvent('order_A', 'pay_A'));
  assert.strictEqual(result.action, 'applied');
  assert.strictEqual(result.to, 'PAID');
  assert.strictEqual(store.getOrder('order_A').status, 'PAID');
  assert.strictEqual(store.getOrder('order_A').payment_id, 'pay_A');
});

test('re-applying captured to an already-PAID order is a no-op (defense in depth)', () => {
  store.createOrder({ id: 'order_B', receipt: 'r', amount: 50000, currency: 'INR' });
  applyEvent(capturedEvent('order_B', 'pay_B'));
  const second = applyEvent(capturedEvent('order_B', 'pay_B'));
  assert.strictEqual(second.action, 'noop');
  assert.strictEqual(store.getOrder('order_B').status, 'PAID');
});

test('out-of-order: authorized AFTER captured does not regress PAID (SCENARIO 4)', () => {
  store.createOrder({ id: 'order_C', receipt: 'r', amount: 50000, currency: 'INR' });
  // captured arrives first
  applyEvent(capturedEvent('order_C', 'pay_C'));
  // then the (late) authorized event shows up
  const authorized = {
    event: 'payment.authorized',
    payload: { payment: { entity: { id: 'pay_C', order_id: 'order_C' } } },
  };
  const result = applyEvent(authorized);
  assert.strictEqual(result.action, 'noop'); // already terminal-correct
  assert.strictEqual(store.getOrder('order_C').status, 'PAID');
});

test('failed event moves CREATED -> FAILED (SCENARIO 5)', () => {
  store.createOrder({ id: 'order_D', receipt: 'r', amount: 50000, currency: 'INR' });
  const failed = {
    event: 'payment.failed',
    payload: { payment: { entity: { id: 'pay_D', order_id: 'order_D' } } },
  };
  const result = applyEvent(failed);
  assert.strictEqual(result.to, 'FAILED');
  assert.strictEqual(store.getOrder('order_D').status, 'FAILED');
});

test('event for unknown order is ignored', () => {
  const result = applyEvent(capturedEvent('order_NOPE', 'pay_x'));
  assert.strictEqual(result.action, 'ignored');
});
