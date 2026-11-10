require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const { db, DATA_DIR } = require('./db');
const SqliteStore = require('./session-store')(session);
const H = require('./helpers');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.use('/uploads/products', express.static(path.join(DATA_DIR, 'uploads', 'products'), { maxAge: '1d' }));

if (!process.env.SESSION_SECRET) console.warn('WARNING: SESSION_SECRET is not set. Set it in .env for production.');
app.use(session({
  store: new SqliteStore(db),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 7 * 24 * 3600 * 1000 }
}));

// Values available in every template
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.shop = H.settings.all();
  res.locals.fmtMoney = H.fmtMoney;
  res.locals.fmtDate = H.fmtDate;
  res.locals.statusLabel = H.statusLabel;
  res.locals.statusClass = H.statusClass;
  res.locals.PAYMENT_METHODS = H.PAYMENT_METHODS;
  res.locals.jsonForScript = H.jsonForScript;
  res.locals.path = req.path;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

app.use(require('./routes/store'));
app.use(require('./routes/auth'));
app.use('/pos', require('./routes/pos'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'The page you are looking for does not exist.' }));
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    return res.status(400).render('error', { title: 'Upload problem', message: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (maximum 8 MB).' : err.message });
  }
  if (err && err.message === 'BAD_FILE_TYPE') {
    return res.status(400).render('error', { title: 'Upload problem', message: 'Only image files (JPG, PNG, WEBP) or PDF are allowed.' });
  }
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => console.log(`Shop running at http://localhost:${PORT}  (data folder: ${DATA_DIR})`));
