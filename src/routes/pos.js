const express = require('express');
const { db } = require('../db');
const H = require('../helpers');
const O = require('../orders');
const { orderPdf } = require('../pdf');

const r = express.Router();
r.use(H.requireLogin);

r.get('/', async (req, res) => {
  const products = await db.all('SELECT p.id, p.name, p.price, p.stock, p.image, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.active = 1 ORDER BY p.name');
  const maxPct = req.session.user.role === 'admin' ? 100 : H.num(H.settings.get('staff_discount_max_percent'), 0);
  res.render('pos/index', { title: 'Point of sale', products, maxPct, error: req.query.error || null });
});

r.post('/sale', async (req, res) => {
  try {
    const isAdmin = req.session.user.role === 'admin';
    let discount = H.num(req.body.discount, 0);
    if (!isAdmin && discount > 0) {
      const maxPct = H.num(H.settings.get('staff_discount_max_percent'), 0);
      if (maxPct <= 0) throw new O.OrderError('Discounts are not allowed for staff. Ask the owner.');
      // compute subtotal to validate the percentage
      const wanted = JSON.parse(req.body.items || '[]');
      let sub = 0;
      for (const it of wanted) { const pr = await db.get('SELECT price FROM products WHERE id = ?', H.int(it.id)); if (pr) sub += pr.price * H.int(it.qty); }
      if (discount > sub * maxPct / 100) throw new O.OrderError(`Staff discounts are limited to ${maxPct}% (max ${H.fmtMoney(sub * maxPct / 100)} on this sale).`);
    }
    const o = await O.createOrder({
      type: 'pos', items: req.body.items, customer_name: String(req.body.customer_name || ''), customer_phone: String(req.body.customer_phone || ''),
      payment_method: H.PAYMENT_METHODS[req.body.payment_method] ? req.body.payment_method : 'cash', discount, staff_id: req.session.user.id
    });
    await H.audit(req, 'sale.created', `${o.invoice_no} ${o.payment_method} total ${o.total}${o.discount ? ' (discount ' + o.discount + ')' : ''}`, o.id);
    res.redirect(`/pos/sale/${o.id}`);
  } catch (e) {
    if (e instanceof O.OrderError) return res.redirect('/pos?error=' + encodeURIComponent(e.message));
    throw e;
  }
});

r.get('/sale/:id', async (req, res) => {
  const o = await O.getOrder(H.int(req.params.id));
  if (!o) return res.status(404).render('error', { title: 'Not found', message: 'Sale not found.' });
  res.render('pos/sale', { title: o.invoice_no, o });
});
r.get('/sale/:id/pdf', async (req, res) => {
  const o = await O.getOrder(H.int(req.params.id));
  if (!o) return res.status(404).end();
  orderPdf(res, o, res.locals.shop, o.type === 'pos' ? 'sale' : (['confirmed', 'collected'].includes(o.status) ? 'receipt' : 'invoice'));
});

// Online orders waiting to be collected (customer shows receipt at the counter)
r.get('/collections', async (req, res) => {
  const q = String(req.query.q || '').trim();
  let found = null;
  if (q) {
    const inv = q.toUpperCase().startsWith('INV-') ? q.toUpperCase() : 'INV-' + q.replace(/\D/g, '').padStart(6, '0');
    found = await O.getOrderByInvoice(inv);
    if (!found) found = await db.get(`SELECT id FROM orders WHERE type='online' AND customer_phone LIKE ? ORDER BY id DESC LIMIT 1`, `%${q.replace(/\D/g, '').slice(-9)}%`);
    if (found && !found.items) found = await O.getOrder(found.id);
  }
  const waiting = await db.all(`SELECT * FROM orders WHERE type = 'online' AND status = 'confirmed' ORDER BY confirmed_at DESC`);
  res.render('pos/collections', { title: 'Collections', q, found, waiting });
});
r.post('/collections/:id/collect', async (req, res) => {
  try { await O.collectOrder(H.int(req.params.id), req.session.user.id); await H.audit(req, 'order.collected', 'order #' + req.params.id, H.int(req.params.id)); H.flash(req, 'ok', 'Order marked as collected.'); }
  catch (e) { if (e instanceof O.OrderError) H.flash(req, 'error', e.message); else throw e; }
  res.redirect('/pos/collections');
});

r.get('/sales', async (req, res) => {
  const tz = H.tzMod();
  const mine = req.session.user.role !== 'admin';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : (await db.get(`SELECT (now() + ?::interval)::date AS d`, tz)).d;
  const rows = await db.all(`SELECT o.*, u.name AS sold_by_name FROM orders o LEFT JOIN users u ON u.id = o.sold_by
    WHERE o.paid_at IS NOT NULL AND o.status IN ('confirmed','collected') AND (o.paid_at + ?::interval)::date = ?::date ${mine ? 'AND o.sold_by = ?' : ''} ORDER BY o.paid_at DESC`,
    ...(mine ? [tz, day, req.session.user.id] : [tz, day]));
  const total = rows.reduce((s, o) => s + o.total, 0);
  const byMethod = {}; for (const o of rows) byMethod[o.payment_method] = (byMethod[o.payment_method] || 0) + o.total;
  const byStaff = {};
  for (const o of rows) { const k = o.sold_by_name || 'Online orders'; const b = byStaff[k] || (byStaff[k] = { n: 0, total: 0, cash: 0, transfer: 0, card: 0 }); b.n++; b.total += o.total; b[o.payment_method] = (b[o.payment_method] || 0) + o.total; }
  const voided = await db.all(`SELECT o.*, u.name AS sold_by_name FROM orders o LEFT JOIN users u ON u.id = o.sold_by WHERE o.type = 'pos' AND o.status = 'cancelled' AND (o.created_at + ?::interval)::date = ?::date ${mine ? 'AND o.sold_by = ?' : ''} ORDER BY o.id DESC`,
    ...(mine ? [tz, day, req.session.user.id] : [tz, day]));
  res.render('pos/sales', { title: 'Sales', rows, total, day, mine, byMethod, byStaff, voided });
});

module.exports = r;
