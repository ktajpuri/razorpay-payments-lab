'use strict';

/**
 * index.js — wires the pieces together.
 *
 * Route map:
 *   GET  /                 -> the one-button client
 *   GET  /config           -> public key + product (client needs the key_id)
 *   POST /create-order     -> orders.createOrder
 *   POST /verify           -> provisional checkout callback (verify.js)
 *   POST /webhook          -> authoritative webhook (webhook.js), RAW body
 *   POST /refund/:orderId  -> refund stub
 *   GET  /orders/:id       -> inspect an order's state (for watching the matrix)
 *
 * Body-parser nuance: the webhook needs the RAW bytes for signature verification,
 * so express.raw() is mounted on that route BEFORE the global express.json().
 */

try { require('dotenv').config(); } catch { /* dotenv optional */ }

const path = require('path');
const express = require('express');

const store = require('./store');
const { PRODUCT, createOrder } = require('./orders');
const { handleVerify } = require('./verify');
const { handleWebhook } = require('./webhook');
const { startSweeper } = require('./sweeper');
const { requireClient, KEY_ID, KEY_SECRET, WEBHOOK_SECRET } = require('./razorpayClient');

const app = express();

// --- Webhook FIRST, with a raw body parser (signature needs exact bytes) ---
app.post('/webhook', express.raw({ type: 'application/json' }), handleWebhook(WEBHOOK_SECRET));

// --- Everything else uses JSON ---
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/config', (req, res) => {
  res.json({ keyId: KEY_ID, product: PRODUCT });
});

app.post('/create-order', async (req, res) => {
  try {
    const order = await createOrder();
    console.log('order created', order)
    res.json(order);
  } catch (err) {
    console.error('[create-order]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/verify', handleVerify(KEY_SECRET));

app.post('/refund/:orderId', async (req, res) => {
  // SCENARIO 8: refund a PAID order. The refund.processed webhook moves it to REFUNDED.
  try {
    const order = store.getOrder(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'unknown order' });
    if (order.status !== 'PAID') return res.status(409).json({ error: `cannot refund ${order.status}` });
    if (!order.payment_id) return res.status(409).json({ error: 'no payment_id on order' });

    const client = requireClient();
    const refund = await client.payments.refund(order.payment_id, {});
    res.json({ ok: true, refund, note: 'REFUNDED will be set when refund.processed webhook arrives' });
  } catch (err) {
    console.error('[refund]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/orders/:id', (req, res) => {
  const order = store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'not found' });
  res.json(order);
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`payments-lab listening on http://localhost:${PORT}`);
    if (!KEY_ID) console.warn('⚠  RAZORPAY_KEY_ID not set — copy .env.example to .env and fill test keys.');
    startSweeper();
  });
}

module.exports = app;
