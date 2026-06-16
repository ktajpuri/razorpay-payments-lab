'use strict';

/**
 * sweeper.js — closes the loop on orders that never resolved.
 *
 * SCENARIO 6: a user opens Checkout and closes it without paying. No callback,
 * no webhook — the order would sit in CREATED forever. The sweeper is the
 * background job that gives every order a terminal state: anything still CREATED
 * past the cutoff becomes ABANDONED.
 *
 * This is the "zero rows left dangling" guarantee that reconciliation depends on.
 */

const store = require('./store');
const { canTransition } = require('./stateMachine');

const ABANDON_AFTER_MS = Number(process.env.ABANDON_AFTER_MS || 15 * 60 * 1000); // 15 min

function sweepOnce(now = Date.now()) {
  const cutoff = now - ABANDON_AFTER_MS;
  const stale = store.staleCreatedOrders(cutoff);
  let swept = 0;
  for (const order of stale) {
    if (canTransition(order.status, 'ABANDONED')) {
      store.updateOrder(order.id, { status: 'ABANDONED' });
      swept++;
    }
  }
  return swept;
}

function startSweeper(intervalMs = 60 * 1000) {
  const timer = setInterval(() => {
    const n = sweepOnce();
    if (n > 0) console.log(`[sweeper] marked ${n} order(s) ABANDONED`);
  }, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = { sweepOnce, startSweeper, ABANDON_AFTER_MS };
