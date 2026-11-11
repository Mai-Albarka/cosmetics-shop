const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const H = require('../helpers');

const r = express.Router();
const attempts = new Map(); // simple login throttle per IP

r.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/pos');
  res.render('login', { title: 'Staff login', error: null });
});

r.post('/login', async (req, res, next) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).render('login', { title: 'Staff login', error: 'Too many attempts. Try again in 15 minutes.' });
  const u = await db.get('SELECT * FROM users WHERE username = ? AND active = 1', String(req.body.username || '').trim().toLowerCase());
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) {
    a.n++; attempts.set(ip, a);
    req.auditName = 'Unknown'; await H.audit(req, 'login.failed', `failed login for "${String(req.body.username || '').slice(0, 40)}"`);
    return res.status(401).render('login', { title: 'Staff login', error: 'Wrong username or password.' });
  }
  attempts.delete(ip);
  req.session.regenerate(async err => {
    if (err) return next(err);
    try {
      req.session.user = { id: u.id, name: u.name, username: u.username, role: u.role };
      await H.audit(req, 'login', `${u.username} logged in`);
      const to = req.session.returnTo; delete req.session.returnTo;
      res.redirect(to || (u.role === 'admin' ? '/admin' : '/pos'));
    } catch (e) { next(e); }
  });
});

r.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

r.get('/account/password', H.requireLogin, (req, res) => res.render('password', { title: 'Change password', error: null }));
r.post('/account/password', H.requireLogin, async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE id = ?', req.session.user.id);
  if (!(await bcrypt.compare(String(req.body.current || ''), u.password_hash))) return res.render('password', { title: 'Change password', error: 'Current password is wrong.' });
  const pw = String(req.body.password || '');
  if (pw.length < 6 || pw !== req.body.confirm) return res.render('password', { title: 'Change password', error: 'New password must be at least 6 characters and match the confirmation.' });
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', await bcrypt.hash(pw, 10), u.id);
  H.flash(req, 'ok', 'Password changed.');
  res.redirect(req.session.user.role === 'admin' ? '/admin' : '/pos');
});

module.exports = r;
