const PDFDocument = require('pdfkit');
const { fmtMoneyPlain, fmtNum, fmtDate, statusLabel, PAYMENT_METHODS } = require('./helpers');

/**
 * Streams a PDF for an order.
 * kind: 'invoice'  -> unpaid online order with bank details
 *       'receipt'  -> confirmed/collected online order (proof of payment to show at the shop)
 *       'sale'     -> point-of-sale receipt
 */
function orderPdf(res, order, shop, kind) {
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  const title = kind === 'invoice' ? 'INVOICE' : kind === 'sale' ? 'SALES RECEIPT' : 'PAYMENT RECEIPT';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${order.invoice_no}-${kind}.pdf"`);
  doc.pipe(res);

  const left = 48, right = 547, width = right - left;
  const accent = '#a3821c';

  // Header
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(20).text(shop.shop_name || 'Shop', left, 48);
  doc.fillColor('#444').font('Helvetica').fontSize(9);
  if (shop.tagline) doc.text(shop.tagline);
  if (shop.address) doc.text(shop.address);
  if (shop.phone) doc.text('Phone: ' + shop.phone);

  doc.fillColor('#111').font('Helvetica-Bold').fontSize(22).text(title, left, 48, { width, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor('#333');
  doc.text(order.invoice_no, { width, align: 'right' });
  doc.text('Date: ' + fmtDate(order.created_at), { width, align: 'right' });
  if (kind !== 'invoice') {
    doc.fillColor('#1b7f3b').font('Helvetica-Bold').fontSize(14).text('PAID', { width, align: 'right' });
  }

  doc.moveTo(left, 130).lineTo(right, 130).strokeColor(accent).lineWidth(1.5).stroke();

  // Customer / meta
  let y = 142;
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(10).text(order.type === 'pos' ? 'Customer' : 'Bill to', left, y);
  doc.font('Helvetica').fontSize(10).fillColor('#333');
  doc.text(order.customer_name || 'Walk-in customer', left, y + 14);
  if (order.customer_phone) doc.text(order.customer_phone);
  if (order.customer_address) doc.text(order.customer_address, { width: 250 });

  const metaX = 340;
  doc.font('Helvetica-Bold').fillColor('#111').text('Details', metaX, y);
  doc.font('Helvetica').fillColor('#333');
  let my = y + 14;
  const meta = [];
  meta.push(['Status', statusLabel(order.status)]);
  if (order.type === 'pos') {
    meta.push(['Payment', PAYMENT_METHODS[order.payment_method] || order.payment_method]);
    if (order.sold_by_name) meta.push(['Served by', order.sold_by_name]);
  } else {
    meta.push(['Order type', 'Online order']);
    if (order.confirmed_at) meta.push(['Payment confirmed', fmtDate(order.confirmed_at)]);
    if (order.collected_at) meta.push(['Collected', fmtDate(order.collected_at)]);
  }
  for (const [k, v] of meta) { doc.text(`${k}: ${v}`, metaX, my, { width: 207 }); my = doc.y; }

  y = Math.max(doc.y, my) + 18;

  // Items table
  const cols = { name: left, qty: 330, price: 380, total: 462 };
  doc.rect(left, y, width, 20).fill('#f6efd8');
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(10);
  doc.text('Item', cols.name + 6, y + 6);
  doc.text('Qty', cols.qty, y + 6, { width: 40, align: 'right' });
  doc.text('Price (NGN)', cols.price, y + 6, { width: 72, align: 'right' });
  doc.text('Total (NGN)', cols.total, y + 6, { width: 79, align: 'right' });
  y += 24;
  doc.font('Helvetica').fontSize(10).fillColor('#222');
  for (const it of order.items) {
    if (y > 720) { doc.addPage(); y = 60; }
    doc.text(it.name, cols.name + 6, y, { width: 270 });
    const h = Math.max(doc.y - y, 12);
    doc.text(String(it.qty), cols.qty, y, { width: 40, align: 'right' });
    doc.text(fmtNum(it.price), cols.price, y, { width: 72, align: 'right' });
    doc.text(fmtNum(it.line_total), cols.total, y, { width: 79, align: 'right' });
    y += h + 6;
    doc.moveTo(left, y - 2).lineTo(right, y - 2).strokeColor('#e5e5e5').lineWidth(0.5).stroke();
  }

  // Totals
  y += 6;
  const totLabel = 330, totVal = 432;
  const tot = [['Subtotal', order.subtotal]];
  if (order.discount > 0) tot.push(['Discount', -order.discount]);
  tot.push(['TOTAL', order.total]);
  for (const [k, v] of tot) {
    const bold = k === 'TOTAL';
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor('#111');
    doc.text(k, totLabel, y, { width: 95, align: 'right' });
    doc.text(fmtMoneyPlain(v), totVal, y, { width: 115, align: 'right' });
    y += bold ? 18 : 15;
  }

  // Payment box / notes
  y += 14;
  if (kind === 'invoice') {
    doc.rect(left, y, width, 96).fill('#fff7e6');
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(11).text('How to pay (bank transfer)', left + 10, y + 10);
    doc.font('Helvetica').fontSize(10).fillColor('#222');
    doc.text(`Bank: ${shop.bank_name || '-'}`, left + 10, y + 28);
    doc.text(`Account number: ${shop.account_number || '-'}`);
    doc.text(`Account name: ${shop.account_name || '-'}`);
    doc.text(`Amount: ${fmtMoneyPlain(order.total)}    Reference: ${order.invoice_no}`);
    y += 106;
    doc.fontSize(9).fillColor('#444').text(shop.invoice_note || '', left, y, { width });
  } else if (kind === 'receipt') {
    doc.rect(left, y, width, 50).fill('#e8f6ec');
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(11).text('Payment confirmed', left + 10, y + 10);
    doc.font('Helvetica').fontSize(10).fillColor('#222')
      .text(order.status === 'collected' ? 'These items have been collected from the shop.' : 'Show this receipt (or your invoice number) at the shop to collect your items.', left + 10, y + 28, { width: width - 20 });
    y += 62;
    doc.fontSize(9).fillColor('#444').text(shop.receipt_note || '', left, y, { width });
  } else {
    doc.fontSize(9).fillColor('#444').text(shop.receipt_note || '', left, y, { width });
  }

  doc.end();
}

module.exports = { orderPdf };
