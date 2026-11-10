const crypto = require('crypto');
const { db } = require('./db');
const { invoiceNo, int, num } = require('./helpers');

class OrderError extends Error {}

function parseItems(raw) {
  let list;
  try { list = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new OrderError('Your cart could not be read. Please try again.'); }
  if (!Array.isArray(list) || list.length === 0) throw new OrderError('Your cart is empty.');
  const merged = new Map();
  for (const it of list) {
    const id = int(it.id), qty = int(it.qty);
    if (id > 0 && qty > 0) merged.set(id, (merged.get(id) || 0) + qty);
  }
  if (merged.size === 0) throw new OrderError('Your cart is empty.');
  return merged;
}

/**
 * Creates an order. For online orders stock is only checked here and deducted on confirmation.
 * For POS sales the items are paid and handed over immediately, so stock is deducted now.
 */
function createOrder({ type, items, customer_name = '', customer_phone = '', customer_address = '', note = '', payment_method = 'transfer', discount = 0, staff_id = null }) {
  const wanted = parseItems(items);
  const getProduct = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
  const lines = [];
  for (const [id, qty] of wanted) {
    const p = getProduct.get(id);
    if (!p) throw new OrderError('One of the products in your cart is no longer available.');
    if (type === 'pos' && p.stock < qty) throw new OrderError(`Only ${p.stock} of "${p.name}" left in stock.`);
    if (type === 'online' && p.stock < qty) throw new OrderError(`Only ${p.stock} of "${p.name}" left in stock. Please reduce the quantity.`);
    lines.push({ product_id: p.id, name: p.name, price: p.price, qty, line_total: Math.round(p.price * qty * 100) / 100 });
  }
  const subtotal = Math.round(lines.reduce((s, l) => s + l.line_total, 0) * 100) / 100;
  discount = Math.min(Math.max(num(discount), 0), subtotal);
  const total = Math.round((subtotal - discount) * 100) / 100;
  const token = crypto.randomBytes(10).toString('hex');
  const isPos = type === 'pos';

  db.exec('BEGIN');
  try {
    const r = db.prepare(`INSERT INTO orders(type, status, customer_name, customer_phone, customer_address, note, subtotal, discount, total,
        payment_method, paid_at, collected_at, collected_by, sold_by, token)
      VALUES (?,?,?,?,?,?,?,?,?,?,${isPos ? "datetime('now'), datetime('now'), ?" : 'NULL, NULL, NULL'},?,?)`)
      .run(...[type, isPos ? 'collected' : 'pending_payment', customer_name.trim(), customer_phone.trim(), customer_address.trim(), note.trim(),
        subtotal, discount, total, isPos ? payment_method : 'transfer', ...(isPos ? [staff_id] : []), staff_id, token]);
    const id = Number(r.lastInsertRowid);
    db.prepare('UPDATE orders SET invoice_no = ? WHERE id = ?').run(invoiceNo(id), id);
    const insItem = db.prepare('INSERT INTO order_items(order_id, product_id, name, price, qty, line_total) VALUES (?,?,?,?,?,?)');
    const decStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
    for (const l of lines) {
      insItem.run(id, l.product_id, l.name, l.price, l.qty, l.line_total);
      if (isPos) decStock.run(l.qty, l.product_id);
    }
    db.exec('COMMIT');
    return getOrder(id);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function getOrder(id) {
  const o = db.prepare(`SELECT o.*, s.name AS sold_by_name, c.name AS confirmed_by_name, k.name AS collected_by_name
    FROM orders o LEFT JOIN users s ON s.id = o.sold_by LEFT JOIN users c ON c.id = o.confirmed_by LEFT JOIN users k ON k.id = o.collected_by
    WHERE o.id = ?`).get(id);
  if (!o) return null;
  o.items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id);
  return o;
}
function getOrderByInvoice(inv) {
  const row = db.prepare('SELECT id FROM orders WHERE invoice_no = ?').get(String(inv || '').trim().toUpperCase());
  return row ? getOrder(row.id) : null;
}

function submitPayment(id, file, note) {
  db.prepare(`UPDATE orders SET payment_proof = ?, payment_note = ?, status = 'payment_submitted', payment_submitted_at = datetime('now'), rejected_reason = ''
    WHERE id = ? AND status IN ('pending_payment','rejected','payment_submitted')`).run(file, note || '', id);
}

function confirmOrder(id, userId) {
  const o = getOrder(id);
  if (!o || !['payment_submitted', 'pending_payment'].includes(o.status)) throw new OrderError('This order cannot be confirmed in its current state.');
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE orders SET status = 'confirmed', confirmed_at = datetime('now'), paid_at = datetime('now'), confirmed_by = ? WHERE id = ?`).run(userId, id);
    const dec = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
    for (const it of o.items) if (it.product_id) dec.run(it.qty, it.product_id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function rejectOrder(id, reason) {
  db.prepare(`UPDATE orders SET status = 'rejected', rejected_reason = ? WHERE id = ? AND status IN ('payment_submitted','pending_payment')`).run(reason || 'Payment could not be verified.', id);
}

function cancelOrder(id) {
  const o = getOrder(id);
  if (!o || ['collected', 'cancelled'].includes(o.status)) throw new OrderError('This order cannot be cancelled.');
  db.exec('BEGIN');
  try {
    if (o.status === 'confirmed') {
      const inc = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
      for (const it of o.items) if (it.product_id) inc.run(it.qty, it.product_id);
    }
    db.prepare(`UPDATE orders SET status = 'cancelled', paid_at = NULL WHERE id = ?`).run(id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Owner-only: a counter sale is never deleted, it is marked VOIDED with a reason and stock is returned.
function voidSale(id, reason) {
  const o = getOrder(id);
  if (!o || o.type !== 'pos' || o.status !== 'collected') throw new OrderError('Only completed counter sales can be voided.');
  if (!reason || !reason.trim()) throw new OrderError('Please give a reason for voiding this sale.');
  db.exec('BEGIN');
  try {
    const inc = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
    for (const it of o.items) if (it.product_id) inc.run(it.qty, it.product_id);
    db.prepare(`UPDATE orders SET status = 'cancelled', paid_at = NULL, rejected_reason = ? WHERE id = ?`).run(reason.trim(), id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function collectOrder(id, userId) {
  const r = db.prepare(`UPDATE orders SET status = 'collected', collected_at = datetime('now'), collected_by = ? WHERE id = ? AND status = 'confirmed'`).run(userId, id);
  if (!r.changes) throw new OrderError('Only orders with confirmed payment can be marked as collected.');
}

module.exports = { OrderError, createOrder, getOrder, getOrderByInvoice, submitPayment, confirmOrder, rejectOrder, cancelOrder, collectOrder, voidSale };
