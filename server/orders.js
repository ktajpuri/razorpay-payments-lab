'use strict';

/**
 * orders.js — order creation. Deliberately one hardcoded product.
 *
 * The catalog is one item on purpose. Nothing about payments is learned by
 * building a catalog, search, or browse, so they are out of scope. The amount is
 * in PAISE (Razorpay's unit): ₹500 = 50000.
 *
 * Flow: we ask Razorpay to create an Order (server-side, authenticated), then
 * persist our own row as CREATED. The Razorpay order_id is the join key between
 * our world and theirs for the rest of the lifecycle.
 */

const crypto = require('crypto');
const { requireClient } = require('./razorpayClient');
const store = require('./store');

const PRODUCT = {
  name: 'The Only Product',
  amount: 50000, // ₹500.00 in paise
  currency: 'INR',
};

async function createOrder() {
  const client = requireClient();
  const receipt = `rcpt_${crypto.randomBytes(6).toString('hex')}`;

  // amount/currency are validated by Razorpay, but we also guard locally.
  if (!Number.isInteger(PRODUCT.amount) || PRODUCT.amount <= 0) {
    throw new Error('invalid amount');
  }

  const rzpOrder = await client.orders.create({
    amount: PRODUCT.amount,
    currency: PRODUCT.currency,
    receipt,
    notes: { product: PRODUCT.name },
  });

  store.createOrder({
    id: rzpOrder.id,
    receipt,
    amount: rzpOrder.amount,
    currency: rzpOrder.currency,
  });

  return rzpOrder;
}

module.exports = { PRODUCT, createOrder };
