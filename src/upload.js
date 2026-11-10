const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./db');

function storage(sub) {
  return multer.diskStorage({
    destination: path.join(DATA_DIR, 'uploads', sub),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '').toLowerCase().slice(0, 6) || '.jpg';
      cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext);
    }
  });
}
const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
function filter(allowPdf) {
  return (req, file, cb) => {
    if (imageTypes.includes(file.mimetype) || (allowPdf && file.mimetype === 'application/pdf')) return cb(null, true);
    cb(new Error('BAD_FILE_TYPE'));
  };
}
const productImage = multer({ storage: storage('products'), limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: filter(false) });
const paymentProof = multer({ storage: storage('receipts'), limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: filter(true) });

module.exports = { productImage, paymentProof };
