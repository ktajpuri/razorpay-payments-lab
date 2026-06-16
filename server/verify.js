'use strict';

/**
 * verify.js — the PROVISIONAL browser callback handler.
 *
 * When Checkout succeeds in the browser, it hands back order_id, payment_id, and
 * a signature. We verify that signature here. But note what this does and does
 * NOT do:
 *
 *   - It DOES prove the callback wasn't tampered with (scenario 1: forged sig -> reject).
 *   - It does NOT finalize money state. The webhook does that.
 *
 * Why not finalize here? Because the callback is unreliable — the user can close
 * the tab and it never fires. Treating this as the source of truth is the classic
 * beginner bug. We optimistically reflect "looks good, pending confirmation" and
 * let the webhook be authoritative.
 */

const store = require('./store');
const { verifyCheckoutSignature } = require('./signatures');

function handleVerify(keySecret) {
  return function (req, res) {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, error: 'missing fields' });
    }

    const valid = verifyCheckoutSignature({
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      signature: razorpay_signature,
      keySecret,
    });

    if (!valid) {
      // SCENARIO 1: tampered/forged signature. Never fulfil. Never trust.
      return res.status(400).json({ ok: false, error: 'signature verification failed' });
    }

    const order = store.getOrder(razorpay_order_id);
    if (!order) {
      return res.status(404).json({ ok: false, error: 'unknown order' });
    }

    // Provisional only. We attach the payment_id but leave the authoritative
    // status transition to the webhook. We deliberately do NOT set PAID here.
    return res.status(200).json({
      ok: true,
      provisional: true,
      message: 'Signature valid. Awaiting webhook confirmation for final status.',
      orderStatus: order.status,
    });
  };
}

module.exports = { handleVerify };
