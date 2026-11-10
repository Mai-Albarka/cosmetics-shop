const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { db, DATA_DIR } = require('../db');
const H = require('../helpers');
const O = require('../orders');
const { productImage } = require('../upload');

const r = express.Router();
r.use(H.requireAdmin);

const PAID = `o.paid_at IS NOT NULL AND o.status IN ('confirmed','collected')`;

const periodStart = { today: `date('now', ?)`, week: `date('now', ?, '-6 days', 'weekday 1')`, month: `date('now', ?, 'start of month')`, year: `date('now', ?, 'start of year')` };

r.get('/', (req, res) => {
  const tz = H.tzMod();
  const stats = {};
  for (const [k, expr] of Object.entries(periodStart)) {
    stats[k] = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(o.total),0) AS total FROM orders o WHERE ${PAID} AND date(o.paid_at, ?) >= ${expr}`).get(tz, tz);
  }
  const daily = db.prepare(`SELECT date(o.paid_at, ?) AS day, COALESCE(SUM(o.total),0) AS total, COUNT(*) AS n FROM orders o WHERE ${PAID} AND date(o.paid_at, ?) >= date('now', ?, '-13 days') GROUP BY day ORDER BY day`).all(tz, tz, tz);
  const pending = db.prepare(`SELECT * FROM orders WHERE type = 'online' AND status = 'payment_submitted' ORDER BY payment_submitted_at`).all();
  const awaitingPayment = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE type='online' AND status='pending_payment'`).get().n;
  const readyForCollection = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE type='online' AND status='confirmed'`).get().n;
  const lowStock = db.prepare(`SELECT * FROM products WHERE active = 1 AND stock <= low_stock ORDER BY stock LIMIT 10`).all();
  const recent = db.prepare(`SELECT o.*, u.name AS sold_by_name FROM orders o LEFT JOIN users u ON u.id = o.sold_by ORDER BY o.id DESC LIMIT 8`).all();
  res.render('admin/dashboard', { title: 'Dashboard', stats, daily, pending, awaitingPayment, readyForCollection, lowStock, recent });
});

// ---------- Orders ----------
r.get('/orders', (req, res) => {
  const status = String(req.query.status || '');
  const type = String(req.query.type || '');
  const q = String(req.query.q || '').trim();
  let sql = `SELECT o.*, u.name AS sold_by_name FROM orders o LEFT JOIN users u ON u.id = o.sold_by WHERE 1=1`;
  const p = [];
  if (status) { sql += ' AND o.status = ?'; p.push(status); }
  if (type) { sql += ' AND o.type = ?'; p.push(type); }
  if (q) { sql += ' AND (o.invoice_no LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?)'; p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY o.id DESC LIMIT 300';
  res.render('admin/orders', { title: 'Orders', orders: db.prepare(sql).all(...p), status, type, q, STATUS: H.STATUS });
});

r.get('/orders/:id', (req, res) => {
  const o = O.getOrder(H.int(req.params.id));
  if (!o) return res.status(404).render('error', { title: 'Not found', message: 'Order not found.' });
  res.render('admin/order', { title: o.invoice_no, o });
});
function act(fn, msg, action) {
  return (req, res) => {
    try { fn(req); H.audit(req, action, (req.body && req.body.reason ? 'reason: ' + req.body.reason : ''), H.int(req.params.id)); H.flash(req, 'ok', msg); }
    catch (e) { if (e instanceof O.OrderError) H.flash(req, 'error', e.message); else throw e; }
    res.redirect('/admin/orders/' + H.int(req.params.id));
  };
}
r.post('/orders/:id/confirm', act(req => O.confirmOrder(H.int(req.params.id), req.session.user.id), 'Payment confirmed. The customer can now collect the order.', 'order.confirmed'));
r.post('/orders/:id/reject', act(req => O.rejectOrder(H.int(req.params.id), String(req.body.reason || '').slice(0, 300)), 'Payment rejected. The customer can upload a new receipt.', 'order.rejected'));
r.post('/orders/:id/cancel', act(req => O.cancelOrder(H.int(req.params.id)), 'Order cancelled.', 'order.cancelled'));
r.post('/orders/:id/collect', act(req => O.collectOrder(H.int(req.params.id), req.session.user.id), 'Order marked as collected.', 'order.collected'));
r.post('/orders/:id/void', act(req => O.voidSale(H.int(req.params.id), String(req.body.reason || '').slice(0, 300)), 'Sale voided. It stays in the records marked VOIDED.', 'sale.voided'));

// ---------- Products & categories ----------
function productForm(res, p, error) {
  res.render('admin/product_form', { title: p.id ? 'Edit product' : 'New product', p, categories: db.prepare('SELECT * FROM categories ORDER BY name').all(), error });
}
r.get('/products', (req, res) => {
  const showInactive = req.query.all === '1';
  const products = db.prepare(`SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id ${showInactive ? '' : 'WHERE p.active = 1'} ORDER BY p.name`).all();
  res.render('admin/products', { title: 'Products', products, showInactive, categories: db.prepare('SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS n FROM categories c ORDER BY name').all() });
});
r.get('/products/new', (req, res) => productForm(res, { id: 0, name: '', description: '', price: '', stock: 0, low_stock: 5, category_id: '', image: null, active: 1 }, null));
r.get('/products/:id/edit', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(H.int(req.params.id));
  if (!p) return res.redirect('/admin/products');
  productForm(res, p, null);
});
function saveProduct(req, res) {
  const id = H.int(req.params.id);
  const p = {
    id, name: String(req.body.name || '').trim(), description: String(req.body.description || '').trim(), price: H.num(req.body.price, -1),
    stock: H.int(req.body.stock, 0), low_stock: H.int(req.body.low_stock, 5), category_id: H.int(req.body.category_id) || null, active: req.body.active ? 1 : 0, image: null
  };
  if (!p.name || p.price < 0) return productForm(res, p, 'Please enter a product name and a valid price.');
  if (id) {
    const old = db.prepare('SELECT image FROM products WHERE id = ?').get(id);
    let image = old ? old.image : null;
    if (req.file) {
      if (image) { try { fs.unlinkSync(path.join(DATA_DIR, 'uploads', 'products', image)); } catch {} }
      image = req.file.filename;
    } else if (req.body.remove_image && image) {
      try { fs.unlinkSync(path.join(DATA_DIR, 'uploads', 'products', image)); } catch {}
      image = null;
    }
    db.prepare('UPDATE products SET name=?, description=?, price=?, stock=?, low_stock=?, category_id=?, active=?, image=? WHERE id=?')
      .run(p.name, p.description, p.price, p.stock, p.low_stock, p.category_id, p.active, image, id);
    H.audit(req, 'product.updated', `#${id} ${p.name} price ${p.price} stock ${p.stock}`);
    H.flash(req, 'ok', 'Product updated.');
  } else {
    db.prepare('INSERT INTO products(name, description, price, stock, low_stock, category_id, active, image) VALUES (?,?,?,?,?,?,?,?)')
      .run(p.name, p.description, p.price, p.stock, p.low_stock, p.category_id, p.active, req.file ? req.file.filename : null);
    H.audit(req, 'product.added', `${p.name} price ${p.price} stock ${p.stock}`);
    H.flash(req, 'ok', 'Product added.');
  }
  res.redirect('/admin/products');
}
r.post('/products', productImage.single('image'), saveProduct);
r.post('/products/:id', productImage.single('image'), saveProduct);
r.post('/products/:id/delete', (req, res) => {
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(H.int(req.params.id));
  H.flash(req, 'ok', 'Product hidden from the shop. You can restore it from "show hidden".');
  res.redirect('/admin/products');
});
r.post('/products/:id/restore', (req, res) => {
  db.prepare('UPDATE products SET active = 1 WHERE id = ?').run(H.int(req.params.id));
  res.redirect('/admin/products?all=1');
});
r.post('/products/:id/stock', (req, res) => {
  const delta = H.int(req.body.delta, 0);
  db.prepare('UPDATE products SET stock = MAX(0, stock + ?) WHERE id = ?').run(delta, H.int(req.params.id));
  H.audit(req, 'stock.adjusted', `product #${req.params.id} by ${delta}`);
  res.redirect(req.get('referer') || '/admin/products');
});
r.post('/categories', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name) db.prepare('INSERT OR IGNORE INTO categories(name) VALUES (?)').run(name);
  res.redirect('/admin/products');
});
r.post('/categories/:id/delete', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(H.int(req.params.id));
  res.redirect('/admin/products');
});

// ---------- Reports ----------
function reportData(req) {
  const tz = H.tzMod();
  const period = ['daily', 'weekly', 'monthly', 'yearly'].includes(req.query.period) ? req.query.period : 'daily';
  const dateOk = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const defaults = { daily: '-29 days', weekly: '-83 days', monthly: '-11 months', yearly: '-9 years' };
  const from = dateOk(req.query.from) ? req.query.from : db.prepare(`SELECT date('now', ?, ?) AS d`).get(tz, defaults[period]).d;
  const to = dateOk(req.query.to) ? req.query.to : db.prepare(`SELECT date('now', ?) AS d`).get(tz).d;
  const bucket = { daily: `date(o.paid_at, ?)`, weekly: `strftime('%Y-W%W', o.paid_at, ?)`, monthly: `strftime('%Y-%m', o.paid_at, ?)`, yearly: `strftime('%Y', o.paid_at, ?)` }[period];
  const where = `${PAID} AND date(o.paid_at, ?) BETWEEN ? AND ?`;
  const rows = db.prepare(`SELECT ${bucket} AS bucket, MIN(date(o.paid_at, ?)) AS first_day, COUNT(*) AS n, COALESCE(SUM(o.total),0) AS total,
      COALESCE(SUM(CASE WHEN o.type='pos' THEN o.total END),0) AS pos_total, COALESCE(SUM(CASE WHEN o.type='online' THEN o.total END),0) AS online_total,
      COALESCE(SUM((SELECT SUM(qty) FROM order_items i WHERE i.order_id = o.id)),0) AS items
    FROM orders o WHERE ${where} GROUP BY bucket ORDER BY bucket`).all(tz, tz, tz, from, to);
  const summary = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(o.total),0) AS total, COALESCE(AVG(o.total),0) AS avg FROM orders o WHERE ${where}`).get(tz, from, to);
  const topProducts = db.prepare(`SELECT i.name, SUM(i.qty) AS qty, SUM(i.line_total) AS total FROM order_items i JOIN orders o ON o.id = i.order_id WHERE ${where} GROUP BY i.name ORDER BY total DESC LIMIT 10`).all(tz, from, to);
  const byStaff = db.prepare(`SELECT COALESCE(u.name, 'Online (customer)') AS name, COUNT(*) AS n, SUM(o.total) AS total FROM orders o LEFT JOIN users u ON u.id = o.sold_by WHERE ${where} GROUP BY o.sold_by ORDER BY total DESC`).all(tz, from, to);
  const byMethod = db.prepare(`SELECT o.payment_method, COUNT(*) AS n, SUM(o.total) AS total FROM orders o WHERE ${where} GROUP BY o.payment_method ORDER BY total DESC`).all(tz, from, to);
  return { period, from, to, rows, summary, topProducts, byStaff, byMethod };
}
r.get('/reports', (req, res) => res.render('admin/reports', { title: 'Sales reports', ...reportData(req) }));
r.get('/reports/export.csv', (req, res) => {
  const d = reportData(req);
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Period', 'Sales count', 'Items sold', 'Shop (POS) total', 'Online total', 'Total'].map(esc).join(',')];
  for (const x of d.rows) lines.push([x.bucket, x.n, x.items, x.pos_total.toFixed(2), x.online_total.toFixed(2), x.total.toFixed(2)].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="sales-${d.period}-${d.from}-to-${d.to}.csv"`);
  res.send(lines.join('\r\n'));
});

// ---------- Staff ----------
r.get('/staff', (req, res) => res.render('admin/staff', { title: 'Staff', staff: db.prepare('SELECT id, name, username, role, active, created_at FROM users ORDER BY role, name').all(), error: null }));
r.post('/staff', async (req, res) => {
  const name = String(req.body.name || '').trim(), username = String(req.body.username || '').trim().toLowerCase(), pw = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'staff';
  const staff = db.prepare('SELECT id, name, username, role, active, created_at FROM users ORDER BY role, name').all();
  if (!name || !/^[a-z0-9_.]{3,30}$/.test(username) || pw.length < 6) return res.render('admin/staff', { title: 'Staff', staff, error: 'Name, a username (letters/numbers, 3-30 chars) and a password of at least 6 characters are required.' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.render('admin/staff', { title: 'Staff', staff, error: 'That username is already taken.' });
  db.prepare('INSERT INTO users(name, username, password_hash, role) VALUES (?,?,?,?)').run(name, username, await bcrypt.hash(pw, 10), role);
  H.audit(req, 'staff.created', `${username} (${role})`);
  H.flash(req, 'ok', 'Account created.');
  res.redirect('/admin/staff');
});
r.post('/staff/:id/toggle', (req, res) => {
  const id = H.int(req.params.id);
  if (id !== req.session.user.id) { db.prepare('UPDATE users SET active = 1 - active WHERE id = ?').run(id); H.audit(req, 'staff.toggled', `user #${id}`); }
  res.redirect('/admin/staff');
});
r.post('/staff/:id/password', async (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length >= 6) { db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(pw, 10), H.int(req.params.id)); H.flash(req, 'ok', 'Password reset.'); }
  else H.flash(req, 'error', 'Password must be at least 6 characters.');
  res.redirect('/admin/staff');
});

// ---------- Activity log ----------
r.get('/activity', (req, res) => {
  const q = String(req.query.q || '').trim();
  const userId = H.int(req.query.user);
  let sql = 'SELECT * FROM audit_log WHERE 1=1'; const p = [];
  if (userId) { sql += ' AND user_id = ?'; p.push(userId); }
  if (q) { sql += ' AND (action LIKE ? OR details LIKE ? OR user_name LIKE ?)'; p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY id DESC LIMIT 400';
  res.render('admin/activity', { title: 'Activity log', rows: db.prepare(sql).all(...p), q, userId, users: db.prepare('SELECT id, name FROM users ORDER BY name').all() });
});

// ---------- Settings ----------
const SETTING_KEYS = ['shop_name', 'tagline', 'phone', 'whatsapp', 'address', 'staff_discount_max_percent', 'bank_name', 'account_number', 'account_name', 'tz_offset_minutes', 'invoice_note', 'receipt_note'];
r.get('/settings', (req, res) => res.render('admin/settings', { title: 'Settings' }));
r.post('/settings', (req, res) => {
  for (const k of SETTING_KEYS) if (k in req.body) H.settings.set(k, String(req.body[k]).trim().slice(0, 1000));
  H.audit(req, 'settings.saved', `discount limit ${req.body.staff_discount_max_percent || 0}%`);
  H.flash(req, 'ok', 'Settings saved.');
  res.redirect('/admin/settings');
});

module.exports = r;
