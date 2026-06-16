'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { canTransition, isTerminal, stateForEvent } = require('../../server/stateMachine');

test('legal transitions are allowed', () => {
  assert.ok(canTransition('CREATED', 'PAID'));
  assert.ok(canTransition('CREATED', 'AUTHORIZED'));
  assert.ok(canTransition('CREATED', 'FAILED'));
  assert.ok(canTransition('CREATED', 'ABANDONED'));
  assert.ok(canTransition('AUTHORIZED', 'PAID'));
  assert.ok(canTransition('PAID', 'REFUNDED'));
});

test('illegal transitions are rejected', () => {
  assert.strictEqual(canTransition('PAID', 'CREATED'), false);
  assert.strictEqual(canTransition('PAID', 'FAILED'), false);
  assert.strictEqual(canTransition('FAILED', 'PAID'), false);
  assert.strictEqual(canTransition('ABANDONED', 'PAID'), false);
  assert.strictEqual(canTransition('REFUNDED', 'PAID'), false);
});

test('terminal states are identified', () => {
  for (const s of ['PAID', 'FAILED', 'ABANDONED', 'REFUNDED']) assert.ok(isTerminal(s));
  for (const s of ['CREATED', 'AUTHORIZED']) assert.strictEqual(isTerminal(s), false);
});

test('event -> state mapping', () => {
  assert.strictEqual(stateForEvent('payment.authorized'), 'AUTHORIZED');
  assert.strictEqual(stateForEvent('payment.captured'), 'PAID');
  assert.strictEqual(stateForEvent('payment.failed'), 'FAILED');
  assert.strictEqual(stateForEvent('refund.processed'), 'REFUNDED');
  assert.strictEqual(stateForEvent('order.paid'), null); // unmapped event ignored
});

test('unknown state throws', () => {
  assert.throws(() => canTransition('NONSENSE', 'PAID'));
});
