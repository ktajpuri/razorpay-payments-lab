'use strict';

/**
 * stateMachine.js — the order lifecycle, made explicit.
 *
 * Money state must never move backwards or sideways into nonsense. A PAID order
 * cannot become CREATED again; a FAILED order cannot silently become PAID. Encoding
 * the legal transitions in one place (rather than scattering `if` checks across
 * handlers) is what lets you reason about correctness — and what lets a reviewer
 * see that you thought about it.
 *
 * Terminal states (PAID, FAILED, ABANDONED, REFUNDED) have no outgoing edges
 * except the one deliberate exception: PAID -> REFUNDED.
 */

const TRANSITIONS = {
  CREATED:    ['AUTHORIZED', 'PAID', 'FAILED', 'ABANDONED'],
  AUTHORIZED: ['PAID', 'FAILED'],
  PAID:       ['REFUNDED'],
  FAILED:     [],
  ABANDONED:  [],
  REFUNDED:   [],
};

const TERMINAL = new Set(['PAID', 'FAILED', 'ABANDONED', 'REFUNDED']);

function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  if (!allowed) throw new Error(`unknown state: ${from}`);
  return allowed.includes(to);
}

function isTerminal(state) {
  return TERMINAL.has(state);
}

/**
 * Decide the target state from a Razorpay webhook event name.
 * Centralizes the event -> state mapping so handlers stay dumb.
 */
function stateForEvent(event) {
  switch (event) {
    case 'payment.authorized': return 'AUTHORIZED';
    case 'payment.captured':   return 'PAID';
    case 'payment.failed':     return 'FAILED';
    case 'refund.processed':   return 'REFUNDED';
    default:                   return null; // event we don't act on
  }
}

module.exports = { TRANSITIONS, canTransition, isTerminal, stateForEvent };
