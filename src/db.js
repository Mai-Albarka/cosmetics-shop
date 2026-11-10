const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'products'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'receipts'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'shop.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  low_stock INTEGER NOT NULL DEFAULT 5,
  image TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('online','pos')),
  status TEXT NOT NULL CHECK (status IN ('pending_payment','payment_submitted','confirmed','collected','rejected','cancelled')),
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  customer_address TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  subtotal REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'transfer',
  payment_proof TEXT,
  payment_note TEXT NOT NULL DEFAULT '',
  payment_submitted_at TEXT,
  paid_at TEXT,
  confirmed_at TEXT,
  confirmed_by INTEGER REFERENCES users(id),
  collected_at TEXT,
  collected_by INTEGER REFERENCES users(id),
  rejected_reason TEXT NOT NULL DEFAULT '',
  sold_by INTEGER REFERENCES users(id),
  token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders(paid_at);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  qty INTEGER NOT NULL,
  line_total REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  user_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  order_id INTEGER,
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`);

// ---- default settings ----
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
const insSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) insSetting.run(k, v);

// ---- first admin account ----
if (!db.prepare('SELECT 1 FROM users WHERE role = ?').get('admin')) {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare('INSERT INTO users(name, username, password_hash, role) VALUES (?,?,?,?)')
    .run('Shop Owner', 'admin', bcrypt.hashSync(pw, 10), 'admin');
  console.log(`Created admin account: username "admin", password "${pw}" (change it after first login)`);
}

// ---- sample catalogue so the shop is not empty on first run ----
if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n === 0) {
  const cats = ['Soap', 'Skincare', 'Hair care', 'Fragrance', 'Makeup'];
  const insCat = db.prepare('INSERT OR IGNORE INTO categories(name) VALUES (?)');
  cats.forEach(c => insCat.run(c));
  const catId = n => db.prepare('SELECT id FROM categories WHERE name = ?').get(n).id;
  const insProd = db.prepare('INSERT INTO products(name, category_id, description, price, stock) VALUES (?,?,?,?,?)');
  insProd.run('Black Soap (500g)', catId('Soap'), 'Traditional African black soap for face and body.', 1500, 40);
  insProd.run('Turmeric Glow Soap', catId('Soap'), 'Brightening turmeric and honey bar.', 2000, 30);
  insProd.run('Shea Butter Body Cream (250ml)', catId('Skincare'), 'Rich moisturising cream with pure shea butter.', 3500, 25);
  insProd.run('Vitamin C Face Serum', catId('Skincare'), 'Brightening serum for an even skin tone.', 6500, 15);
  insProd.run('Coconut Hair Oil (200ml)', catId('Hair care'), 'Nourishing oil for scalp and hair growth.', 2800, 20);
  insProd.run('Oud Body Spray', catId('Fragrance'), 'Long-lasting oriental fragrance.', 4500, 18);
  insProd.run('Matte Lipstick', catId('Makeup'), 'Smooth, long-wear matte finish.', 2500, 35);
  insProd.run('Sunscreen SPF 50 (100ml)', catId('Skincare'), 'Broad-spectrum daily sun protection.', 5500, 12);
}

module.exports = { db, DATA_DIR };
