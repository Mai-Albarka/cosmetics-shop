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
async function createOrder({ type, items, customer_name = '', customer_phone = '', customer_address = '', note = '', payment_method = 'transfer', discount = 0, staff_id = null }) {
  const wanted = parseItems(items);
  const lines = [];
  for (const [id, qty] of wanted) {
    const p = await db.get('SELECT * FROM products WHERE id = ? AND active = 1', id);
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

  const id = await db.tx(async tx => {
    const r = await tx.get(`INSERT INTO orders(type, status, customer_name, customer_phone, customer_address, note, subtotal, discount, total,
        payment_method, paid_at, collected_at, collected_by, sold_by, token)
      VALUES (?,?,?,?,?,?,?,?,?,?,${isPos ? 'now(), now(), ?' : 'NULL, NULL, NULL'},?,?) RETURNING id`,
      ...[type, isPos ? 'collected' : 'pending_payment', customer_name.trim(), customer_phone.trim(), customer_address.trim(), note.trim(),
        subtotal, discount, total, isPos ? payment_method : 'transfer', ...(isPos ? [staff_id] : []), staff_id, token]);
    const id = Number(r.id);
    await tx.run('UPDATE orders SET invoice_no = ? WHERE id = ?', invoiceNo(id), id);
    for (const l of lines) {
      await tx.run('INSERT INTO order_items(order_id, product_id, name, price, qty, line_total) VALUES (?,?,?,?,?,?)', id, l.product_id, l.name, l.price, l.qty, l.line_total);
      if (isPos) await tx.run('UPDATE products SET stock = stock - ? WHERE id = ?', l.qty, l.product_id);
    }
    return id;
  });
  return getOrder(id);
}

async function getOrder(id) {
  const o = await db.get(`SELECT o.*, s.name AS sold_by_name, c.name AS confirmed_by_name, k.name AS collected_by_name
    FROM orders o LEFT JOIN users s ON s.id = o.sold_by LEFT JOIN users c ON c.id = o.confirmed_by LEFT JOIN users k ON k.id = o.collected_by
    WHERE o.id = ?`, id);
  if (!o) return null;
  o.items = await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', id);
  return o;
}
async function getOrderByInvoice(inv) {
  const row = await db.get('SELECT id FROM orders WHERE invoice_no = ?', String(inv || '').trim().toUpperCase());
  return row ? getOrder(row.id) : null;
}

async function submitPayment(id, file, note) {
  await db.run(`UPDATE orders SET payment_proof = ?, payment_note = ?, status = 'payment_submitted', payment_submitted_at = now(), rejected_reason = ''
    WHERE id = ? AND status IN ('pending_payment','rejected','payment_submitted')`, file, note || '', id);
}

async function confirmOrder(id, userId) {
  const o = await getOrder(id);
  if (!o || !['payment_submitted', 'pending_payment'].includes(o.status)) throw new OrderError('This order cannot be confirmed in its current state.');
  await db.tx(async tx => {
    await tx.run(`UPDATE orders SET status = 'confirmed', confirmed_at = now(), paid_at = now(), confirmed_by = ? WHERE id = ?`, userId, id);
    for (const it of o.items) if (it.product_id) await tx.run('UPDATE products SET stock = stock - ? WHERE id = ?', it.qty, it.product_id);
  });
}

async function rejectOrder(id, reason) {
  await db.run(`UPDATE orders SET status = 'rejected', rejected_reason = ? WHERE id = ? AND status IN ('payment_submitted','pending_payment')`, reason || 'Payment could not be verified.', id);
}

async function cancelOrder(id) {
  const o = await getOrder(id);
  if (!o || ['collected', 'cancelled'].includes(o.status)) throw new OrderError('This order cannot be cancelled.');
  await db.tx(async tx => {
    if (o.status === 'confirmed') {
      for (const it of o.items) if (it.product_id) await tx.run('UPDATE products SET stock = stock + ? WHERE id = ?', it.qty, it.product_id);
    }
    await tx.run(`UPDATE orders SET status = 'cancelled', paid_at = NULL WHERE id = ?`, id);
  });
}

// Owner-only: a counter sale is never deleted, it is marked VOIDED with a reason and stock is returned.
async function voidSale(id, reason) {
  const o = await getOrder(id);
  if (!o || o.type !== 'pos' || o.status !== 'collected') throw new OrderError('Only completed counter sales can be voided.');
  if (!reason || !reason.trim()) throw new OrderError('Please give a reason for voiding this sale.');
  await db.tx(async tx => {
    for (const it of o.items) if (it.product_id) await tx.run('UPDATE products SET stock = stock + ? WHERE id = ?', it.qty, it.product_id);
    await tx.run(`UPDATE orders SET status = 'cancelled', paid_at = NULL, rejected_reason = ? WHERE id = ?`, reason.trim(), id);
  });
}

async function collectOrder(id, userId) {
  const r = await db.run(`UPDATE orders SET status = 'collected', collected_at = now(), collected_by = ? WHERE id = ? AND status = 'confirmed'`, userId, id);
  if (!r.changes) throw new OrderError('Only orders with confirmed payment can be marked as collected.');
}

module.exports = { OrderError, createOrder, getOrder, getOrderByInvoice, submitPayment, confirmOrder, rejectOrder, cancelOrder, collectOrder, voidSale };
