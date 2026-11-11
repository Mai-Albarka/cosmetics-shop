#!/usr/bin/env node
// One-time copy of the old SQLite database (DATA_DIR/shop.db) into Supabase.
//
//   node scripts/migrate-from-sqlite.js            # refuses if Supabase already holds orders
//   node scripts/migrate-from-sqlite.js --replace  # wipes the Supabase tables first, then copies
//
// Uses DIRECT_URL (falls back to DATABASE_URL). Uploaded images stay in DATA_DIR/uploads and are not touched.
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const sqlitePath = process.argv.find(a => a.endsWith('.db')) || path.join(DATA_DIR, 'shop.db');
const replace = process.argv.includes('--replace');
const url = process.env.DIRECT_URL || process.env.DATABASE_URL;

if (!url) { console.error('Set DATABASE_URL / DIRECT_URL in .env first.'); process.exit(1); }
if (!fs.existsSync(sqlitePath)) { console.error(`SQLite file not found: ${sqlitePath}`); process.exit(1); }

const ssl = /sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : { rejectUnauthorized: false };
const pg = new Pool({ connectionString: url, ssl, max: 1 });
const lite = new DatabaseSync(sqlitePath, { readOnly: true });

const ts = s => (s ? new Date(String(s).replace(' ', 'T') + 'Z') : null);
const TABLES = ['settings', 'users', 'categories', 'products', 'orders', 'order_items', 'audit_log'];

async function copy(client, table, cols, map = r => r) {
  const rows = lite.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'settings' ? 'key' : 'id'}`).all();
  const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
  for (const r of rows) {
    const m = map(r);
    await client.query(`INSERT INTO ${table}(${cols.join(',')}) VALUES (${ph}) ON CONFLICT DO NOTHING`, cols.map(c => m[c]));
  }
  if (table !== 'settings') await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))`);
  console.log(`${table}: ${rows.length} rows`);
}

(async () => {
  const client = await pg.connect();
  try {
    const have = (await client.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n;
    if (have > 0 && !replace) {
      console.error(`Supabase already has ${have} orders. Run again with --replace to wipe and re-import.`);
      process.exit(1);
    }
    await client.query('BEGIN');
    await client.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    await copy(client, 'settings', ['key', 'value']);
    await copy(client, 'users', ['id', 'name', 'username', 'password_hash', 'role', 'active', 'created_at'], r => ({ ...r, created_at: ts(r.created_at) }));
    await copy(client, 'categories', ['id', 'name']);
    await copy(client, 'products', ['id', 'name', 'category_id', 'description', 'price', 'stock', 'low_stock', 'image', 'active', 'created_at'], r => ({ ...r, created_at: ts(r.created_at) }));
    await copy(client, 'orders', ['id', 'invoice_no', 'type', 'status', 'customer_name', 'customer_phone', 'customer_address', 'note', 'subtotal', 'discount', 'total',
      'payment_method', 'payment_proof', 'payment_note', 'payment_submitted_at', 'paid_at', 'confirmed_at', 'confirmed_by', 'collected_at', 'collected_by', 'rejected_reason', 'sold_by', 'token', 'created_at'],
      r => ({ ...r, payment_submitted_at: ts(r.payment_submitted_at), paid_at: ts(r.paid_at), confirmed_at: ts(r.confirmed_at), collected_at: ts(r.collected_at), created_at: ts(r.created_at) }));
    await copy(client, 'order_items', ['id', 'order_id', 'product_id', 'name', 'price', 'qty', 'line_total']);
    await copy(client, 'audit_log', ['id', 'user_id', 'user_name', 'action', 'details', 'order_id', 'ip', 'created_at'], r => ({ ...r, created_at: ts(r.created_at) }));
    await client.query('COMMIT');
    console.log('Done. Your SQLite data is now in Supabase.');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration failed, nothing was changed:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pg.end();
    lite.close();
  }
})();
