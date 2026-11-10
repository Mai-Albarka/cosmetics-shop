const express = require('express');
const path = require('path');
const fs = require('fs');
const { db, DATA_DIR } = require('../db');
const H = require('../helpers');
const O = require('../orders');
const { paymentProof } = require('../upload');
const { orderPdf } = require('../pdf');

const r = express.Router();

function categories() { return db.prepare('SELECT * FROM categories ORDER BY name').all(); }

r.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  const cat = H.int(req.query.category);
  let sql = 'SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.active = 1';
  const params = [];
  if (q) { sql += ' AND (p.name LIKE ? OR p.description LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  if (cat) { sql += ' AND p.category_id = ?'; params.push(cat); }
  sql += ' ORDER BY p.name';
  res.render('store/home', { title: 'Shop', products: db.prepare(sql).all(...params), categories: categories(), q, cat });
});

r.get('/product/:id', (req, res) => {
  const p = db.prepare('SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ? AND p.active = 1').get(H.int(req.params.id));
  if (!p) return res.status(404).render('error', { title: 'Not found', message: 'That product is not available.' });
  res.render('store/product', { title: p.name, p });
});

r.get('/api/products', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(s => H.int(s)).filter(n => n > 0).slice(0, 100);
  if (!ids.length) return res.json([]);
  const rows = db.prepare(`SELECT id, name, price, stock, image FROM products WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  res.json(rows);
});

r.get('/cart', (req, res) => res.render('store/cart', { title: 'Your cart' }));
r.get('/checkout', (req, res) => res.render('store/checkout', { title: 'Checkout', error: null, form: {} }));

r.post('/checkout', (req, res) => {
  const form = { name: String(req.body.name || ''), phone: String(req.body.phone || ''), address: String(req.body.address || ''), note: String(req.body.note || '') };
  if (!form.name.trim() || !form.phone.trim()) return res.status(400).render('store/checkout', { title: 'Checkout', error: 'Please enter your name and phone number.', form });
  try {
    const order = O.createOrder({ type: 'online', items: req.body.items, customer_name: form.name, customer_phone: form.phone, customer_address: form.address, note: form.note });
    H.audit(req, 'order.placed', `${order.invoice_no} by ${order.customer_name} (${order.customer_phone}) total ${order.total}`, order.id);
    res.redirect(`/order/${order.invoice_no}?token=${order.token}&new=1`);
  } catch (e) {
    if (e instanceof O.OrderError) return res.status(400).render('store/checkout', { title: 'Checkout', error: e.message, form });
    throw e;
  }
});

// Customer can open the order with the secret token in the link; staff can open any order.
function loadOrder(req, res, next) {
  const o = O.getOrderByInvoice(req.params.inv);
  if (!o) return res.status(404).render('error', { title: 'Order not found', message: 'No order with that invoice number.' });
  const token = req.query.token || (req.body && req.body.token);
  if (!(req.session.user || (token && token === o.token))) {
    return res.status(403).render('store/track', { title: 'Track order', error: 'Enter your invoice number and the phone number used on the order to open it.', inv: o.invoice_no });
  }
  req.order = o;
  next();
}

r.get('/order/:inv', loadOrder, (req, res) => {
  res.render('store/order', { title: req.order.invoice_no, o: req.order, token: req.order.token, isNew: req.query.new === '1' });
});

r.post('/order/:inv/payment', loadOrder, paymentProof.single('screenshot'), (req, res) => {
  const o = req.order;
  if (!['pending_payment', 'rejected', 'payment_submitted'].includes(o.status)) {
    H.flash(req, 'error', 'This order no longer accepts payment uploads.');
    return res.redirect(`/order/${o.invoice_no}?token=${o.token}`);
  }
  if (!req.file) { H.flash(req, 'error', 'Please choose the screenshot of your transfer receipt.'); return res.redirect(`/order/${o.invoice_no}?token=${o.token}`); }
  if (o.payment_proof) { try { fs.unlinkSync(path.join(DATA_DIR, 'uploads', 'receipts', o.payment_proof)); } catch {} }
  O.submitPayment(o.id, req.file.filename, String(req.body.payment_note || '').slice(0, 500));
  H.audit(req, 'payment.uploaded', `${o.invoice_no} receipt ${req.file.filename}`, o.id);
  H.flash(req, 'ok', 'Your payment receipt was sent to the shop. We will confirm it shortly.');
  res.redirect(`/order/${o.invoice_no}?token=${o.token}`);
});

r.get('/order/:inv/pdf', loadOrder, (req, res) => {
  const o = req.order;
  let kind = req.query.type === 'receipt' ? 'receipt' : 'invoice';
  if (o.type === 'pos') kind = 'sale';
  if (kind === 'receipt' && !['confirmed', 'collected'].includes(o.status)) kind = 'invoice';
  orderPdf(res, o, res.locals.shop, kind);
});

r.get('/payment-proof/:inv', loadOrder, (req, res) => {
  const o = req.order;
  if (!o.payment_proof) return res.status(404).end();
  res.sendFile(path.join(DATA_DIR, 'uploads', 'receipts', path.basename(o.payment_proof)));
});

r.get('/track', (req, res) => res.render('store/track', { title: 'Track order', error: null, inv: '' }));
r.post('/track', (req, res) => {
  const inv = String(req.body.invoice || '').trim().toUpperCase();
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  const o = O.getOrderByInvoice(inv.startsWith('INV-') ? inv : 'INV-' + inv.padStart(6, '0'));
  if (!o || o.type !== 'online' || !phone || o.customer_phone.replace(/\D/g, '').slice(-9) !== phone.slice(-9)) {
    return res.status(404).render('store/track', { title: 'Track order', error: 'No order found with that invoice number and phone number.', inv });
  }
  res.redirect(`/order/${o.invoice_no}?token=${o.token}`);
});

module.exports = r;
