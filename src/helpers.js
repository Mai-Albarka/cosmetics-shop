const { db } = require('./db');

const moneyFmt = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 2 });
const plainFmt = new Intl.NumberFormat('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtMoney(n) { return moneyFmt.format(Number(n) || 0); }
function fmtMoneyPlain(n) { return 'NGN ' + plainFmt.format(Number(n) || 0); }
function fmtNum(n) { return plainFmt.format(Number(n) || 0); }

// Settings are loaded from the database once per request (see server.js) and kept in memory,
// so templates, PDFs and date helpers can read them synchronously.
let cache = {};
const settings = {
  async load() {
    const o = {};
    for (const r of await db.all('SELECT key, value FROM settings')) o[r.key] = r.value;
    cache = o;
    return o;
  },
  all() { return cache; },
  get(k) { return cache[k] ?? ''; },
  async set(k, v) {
    await db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', k, String(v ?? ''));
    cache[k] = String(v ?? '');
  }
};

function tzOffsetMinutes() { return parseInt(settings.get('tz_offset_minutes') || '60', 10) || 0; }
// Postgres interval that shifts a UTC timestamp into shop-local time: use as  (col + ?::interval)::date
function tzMod() { return tzOffsetMinutes() + ' minutes'; }

function fmtDate(s, withTime = true) {
  if (!s) return '';
  const d = s instanceof Date ? s : new Date(/^\d{4}-\d{2}-\d{2} \d/.test(String(s)) ? String(s).replace(' ', 'T') + 'Z' : s);
  if (isNaN(d)) return String(s);
  const local = new Date(d.getTime() + tzOffsetMinutes() * 60000);
  const day = local.toISOString().slice(0, 10);
  const time = local.toISOString().slice(11, 16);
  const [y, m, dd] = day.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const nice = `${dd} ${months[parseInt(m, 10) - 1]} ${y}`;
  return withTime ? `${nice}, ${time}` : nice;
}

function invoiceNo(id) { return 'INV-' + String(id).padStart(6, '0'); }

const STATUS = {
  pending_payment:   { label: 'Awaiting payment',                 cls: 'warn' },
  payment_submitted: { label: 'Receipt uploaded, awaiting confirmation', cls: 'info' },
  confirmed:         { label: 'Paid, ready for collection',        cls: 'ok' },
  collected:         { label: 'Collected',                         cls: 'done' },
  rejected:          { label: 'Payment rejected',                  cls: 'bad' },
  cancelled:         { label: 'Cancelled',                         cls: 'muted' }
};
function statusLabel(s) { return (STATUS[s] || { label: s }).label; }
function statusClass(s) { return (STATUS[s] || { cls: 'muted' }).cls; }

const PAYMENT_METHODS = { cash: 'Cash', transfer: 'Bank transfer', card: 'Card / POS machine' };

function requireLogin(req, res, next) {
  if (!req.session.user) { req.session.returnTo = req.originalUrl; return res.redirect('/login'); }
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user) { req.session.returnTo = req.originalUrl; return res.redirect('/login'); }
  if (req.session.user.role !== 'admin') return res.status(403).render('error', { title: 'Not allowed', message: 'This area is for the shop owner only.' });
  next();
}
function flash(req, type, msg) { req.session.flash = { type, msg }; }

// Safe JSON for embedding inside a <script> tag
function jsonForScript(v) { return JSON.stringify(v).replace(/</g, '\\u003c'); }

async function audit(req, action, details = '', orderId = null) {
  const u = req && req.session && req.session.user;
  await db.run('INSERT INTO audit_log(user_id, user_name, action, details, order_id, ip) VALUES (?,?,?,?,?,?)',
    u ? u.id : null, u ? u.name : (req && req.auditName) || 'Customer', action, String(details).slice(0, 500), orderId, req && req.ip ? String(req.ip).slice(0, 64) : '');
}

function num(v, d = 0) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function int(v, d = 0) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

module.exports = { audit, fmtMoney, fmtMoneyPlain, fmtNum, settings, tzMod, tzOffsetMinutes, fmtDate, invoiceNo, STATUS, statusLabel, statusClass, PAYMENT_METHODS, requireLogin, requireAdmin, flash, jsonForScript, num, int };
