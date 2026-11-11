// Database layer: Supabase (Postgres) through node-postgres.
//
//   DATABASE_URL  pooled connection string (Supabase "Transaction pooler", port 6543) used by the app
//   DIRECT_URL    direct connection string (port 5432) used for creating tables at startup
//
// Queries are written with "?" placeholders (like the old SQLite code) and converted to $1, $2, ... here.
const { Pool, types } = require('pg');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'products'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'receipts'), { recursive: true });

// Return numbers as JS numbers (pg gives strings for bigint/numeric by default) and dates as plain "YYYY-MM-DD" strings.
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));      // int8 (COUNT, SUM of integers)
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));      // numeric (prices, totals)
types.setTypeParser(1082, v => v);                                        // date

const DATABASE_URL = process.env.DATABASE_URL;
const DIRECT_URL = process.env.DIRECT_URL || DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Put your Supabase connection strings (DATABASE_URL and DIRECT_URL) in .env');
  process.exit(1);
}

// Explains a failed connection without revealing the connection string itself.
function describeFailure(varName, url, err) {
  const hints = [];
  try {
    const u = new URL(url);
    const pooler = /pooler\.supabase\.com$/.test(u.hostname);
    if (pooler && !u.username.includes('.')) hints.push('On a Supabase pooler the username must be "postgres.<project-ref>", not just "postgres" (copy the string from the dashboard).');
    if (!pooler && /^db\..*\.supabase\.co$/.test(u.hostname)) hints.push('Direct Supabase hosts are IPv6-only; use the "Session pooler" string instead if your network has no IPv6.');
    if (/\[YOUR-PASSWORD\]/i.test(url)) hints.push('Replace [YOUR-PASSWORD] with the real database password.');
    if (/password authentication failed/.test(err.message)) hints.push('Check the database password (Project Settings > Database > Reset database password), and URL-encode any @ # / ? % characters in it.');
  } catch { hints.push(varName + ' is not a valid URL.'); }
  return `${varName} failed: ${err.message}` + (hints.length ? '\n  - ' + hints.join('\n  - ') : '');
}

function sslFor(url) {
  if (/sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url)) return false;
  return { rejectUnauthorized: false };
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: sslFor(DATABASE_URL), max: 10, idleTimeoutMillis: 30000 });
pool.on('error', err => console.error('Postgres pool error:', err.message));

function toPg(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => '$' + (++n));
}

// Small query helpers shared by the pool and by transaction clients.
function wrap(q) {
  return {
    all: async (sql, ...params) => (await q.query(toPg(sql), params)).rows,
    get: async (sql, ...params) => (await q.query(toPg(sql), params)).rows[0] || null,
    run: async (sql, ...params) => { const r = await q.query(toPg(sql), params); return { changes: r.rowCount, rows: r.rows }; },
    exec: async sql => { await q.query(sql); },
    query: (sql, params = []) => q.query(toPg(sql), params)
  };
}

const db = wrap(pool);

// Runs fn(tx) inside a transaction; tx has the same all/get/run helpers.
db.tx = async function (fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(wrap(client));
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
};

db.close = () => pool.end();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  low_stock INTEGER NOT NULL DEFAULT 5,
  image TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  invoice_no TEXT UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('online','pos')),
  status TEXT NOT NULL CHECK (status IN ('pending_payment','payment_submitted','confirmed','collected','rejected','cancelled')),
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  customer_address TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'transfer',
  payment_proof TEXT,
  payment_note TEXT NOT NULL DEFAULT '',
  payment_submitted_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  confirmed_by INTEGER REFERENCES users(id),
  collected_at TIMESTAMPTZ,
  collected_by INTEGER REFERENCES users(id),
  rejected_reason TEXT NOT NULL DEFAULT '',
  sold_by INTEGER REFERENCES users(id),
  token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders(paid_at);
CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  price NUMERIC(12,2) NOT NULL,
  qty INTEGER NOT NULL,
  line_total NUMERIC(12,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  user_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  order_id INTEGER,
  ip TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires BIGINT NOT NULL
);
`;

const defaults = {
  shop_name: 'Man and Brothers Cosmetics',
  tagline: 'Quality soap, skincare and cosmetics',
  phone: '',
  address: '',
  bank_name: '',
  account_number: '',
  account_name: '',
  tz_offset_minutes: '60',
  staff_discount_max_percent: '0',
  whatsapp: '',
  invoice_note: 'Pay the exact amount to the account above, then upload a screenshot of your transfer receipt on your order page. Your order is ready for collection once payment is confirmed.',
  receipt_note: 'Thank you for shopping with us.'
};

// Creates tables, default settings, the first admin and a sample catalogue. Safe to run on every start.
async function init() {
  const directVar = process.env.DIRECT_URL ? 'DIRECT_URL' : 'DATABASE_URL';
  const direct = new Pool({ connectionString: DIRECT_URL, ssl: sslFor(DIRECT_URL), max: 1 });
  const d = wrap(direct);
  try {
    try { await d.exec('SELECT 1'); } catch (e) { throw new Error(describeFailure(directVar, DIRECT_URL, e)); }
    if (DIRECT_URL !== DATABASE_URL) {
      try { await db.exec('SELECT 1'); } catch (e) { throw new Error(describeFailure('DATABASE_URL', DATABASE_URL, e)); }
    }
    await d.exec(SCHEMA);
    for (const [k, v] of Object.entries(defaults)) await d.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', k, v);

    if (!(await d.get('SELECT 1 FROM users WHERE role = ?', 'admin'))) {
      const pw = process.env.ADMIN_PASSWORD || 'admin123';
      await d.run('INSERT INTO users(name, username, password_hash, role) VALUES (?,?,?,?)', 'Shop Owner', 'admin', bcrypt.hashSync(pw, 10), 'admin');
      console.log(`Created admin account: username "admin", password "${pw}" (change it after first login)`);
    }

    if ((await d.get('SELECT COUNT(*) AS n FROM products')).n === 0) {
      const cats = ['Soap', 'Skincare', 'Hair care', 'Fragrance', 'Makeup'];
      for (const c of cats) await d.run('INSERT INTO categories(name) VALUES (?) ON CONFLICT (name) DO NOTHING', c);
      const catId = async n => (await d.get('SELECT id FROM categories WHERE name = ?', n)).id;
      const samples = [
        ['Black Soap (500g)', 'Soap', 'Traditional African black soap for face and body.', 1500, 40],
        ['Turmeric Glow Soap', 'Soap', 'Brightening turmeric and honey bar.', 2000, 30],
        ['Shea Butter Body Cream (250ml)', 'Skincare', 'Rich moisturising cream with pure shea butter.', 3500, 25],
        ['Vitamin C Face Serum', 'Skincare', 'Brightening serum for an even skin tone.', 6500, 15],
        ['Coconut Hair Oil (200ml)', 'Hair care', 'Nourishing oil for scalp and hair growth.', 2800, 20],
        ['Oud Body Spray', 'Fragrance', 'Long-lasting oriental fragrance.', 4500, 18],
        ['Matte Lipstick', 'Makeup', 'Smooth, long-wear matte finish.', 2500, 35],
        ['Sunscreen SPF 50 (100ml)', 'Skincare', 'Broad-spectrum daily sun protection.', 5500, 12]
      ];
      for (const [name, cat, desc, price, stock] of samples) {
        await d.run('INSERT INTO products(name, category_id, description, price, stock) VALUES (?,?,?,?,?)', name, await catId(cat), desc, price, stock);
      }
    }
  } finally {
    await direct.end();
  }
}

module.exports = { db, init, DATA_DIR };
