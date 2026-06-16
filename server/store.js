'use strict';

/**
 * store.js — the durable state behind the whole flow.
 *
 * Why SQLite and not a JSON file?  Because idempotency is the centerpiece of
 * this project, and idempotency must be ATOMIC. A naive JSON read-modify-write
 * has a race: two webhooks arriving at once both read "not processed", both
 * proceed, and you double-fulfil. A UNIQUE constraint + INSERT pushes that
 * atomicity down into the database where it belongs. That subtlety is itself
 * one of the payments lessons — see processed_events below.
 *
 * Everything the rest of the app needs to know about an order's truth lives
 * here. The store is intentionally a thin repository: swapping SQLite for
 * Postgres later is a one-file change behind this interface.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'payments.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id            TEXT PRIMARY KEY,   -- Razorpay order_id
    receipt       TEXT NOT NULL,
    amount        INTEGER NOT NULL,   -- in paise
    currency      TEXT NOT NULL,
    status        TEXT NOT NULL,      -- CREATED | AUTHORIZED | PAID | FAILED | ABANDONED | REFUNDED
    payment_id    TEXT,               -- set once a payment is associated
    created_at    INTEGER NOT NULL,   -- epoch ms
    updated_at    INTEGER NOT NULL
  );

  -- The idempotency ledger. Razorpay sends an X-Razorpay-Event-Id header that is
  -- stable across redeliveries of the SAME event. We INSERT it here BEFORE acting.
  -- The UNIQUE primary key means a duplicate delivery throws on insert, which we
  -- catch and treat as "already handled — do nothing". Atomic, race-free.
  CREATE TABLE IF NOT EXISTS processed_events (
    event_id      TEXT PRIMARY KEY,
    processed_at  INTEGER NOT NULL
  );
`);

function now() {
  return Date.now();
}

const store = {
  createOrder({ id, receipt, amount, currency }) {
    const ts = now();
    db.prepare(
      `INSERT INTO orders (id, receipt, amount, currency, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'CREATED', ?, ?)`
    ).run(id, receipt, amount, currency, ts, ts);
    return store.getOrder(id);
  },

  getOrder(id) {
    return db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id);
  },

  updateOrder(id, { status, payment_id }) {
    const existing = store.getOrder(id);
    if (!existing) throw new Error(`order ${id} not found`);
    db.prepare(
      `UPDATE orders SET status = ?, payment_id = COALESCE(?, payment_id), updated_at = ? WHERE id = ?`
    ).run(status, payment_id ?? null, now(), id);
    return store.getOrder(id);
  },

  /**
   * Atomic idempotency guard.
   * Returns true if this event_id is NEW (caller should proceed),
   * false if it was already processed (caller should no-op).
   */
  markEventProcessed(eventId) {
    try {
      db.prepare(
        `INSERT INTO processed_events (event_id, processed_at) VALUES (?, ?)`
      ).run(eventId, now());
      return true; // first time we've seen this event
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return false; // duplicate
      throw err;
    }
  },

  // Used by the sweeper: orders still CREATED older than the cutoff.
  staleCreatedOrders(cutoffMs) {
    return db.prepare(
      `SELECT * FROM orders WHERE status = 'CREATED' AND created_at < ?`
    ).all(cutoffMs);
  },

  // Test/utility helpers
  _db: db,
  _reset() {
    db.exec(`DELETE FROM orders; DELETE FROM processed_events;`);
  },
};

module.exports = store;
