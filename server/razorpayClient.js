'use strict';

/**
 * razorpayClient.js — the gateway client and config, in one place.
 *
 * Keys come from the environment, never from source. In TEST MODE these are your
 * test keys (rzp_test_...). The same code with live keys (rzp_live_...) is what
 * goes to production — there is no separate "staging gateway", only test vs live
 * key sets. That is the whole environment story.
 */

const Razorpay = require('razorpay');

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

// Allow the unit tests (which never call the gateway) to load the app without keys.
const instance = (KEY_ID && KEY_SECRET)
  ? new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET })
  : null;

function requireClient() {
  if (!instance) {
    throw new Error(
      'Razorpay client not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env'
    );
  }
  return instance;
}

module.exports = {
  instance,
  requireClient,
  KEY_ID,
  KEY_SECRET,
  WEBHOOK_SECRET,
};
