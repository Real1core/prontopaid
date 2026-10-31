// The PDF of a quote or invoice: company header, who it's for, the items, totals, and for a
// quote an approval line (or who approved it online); for an invoice the payments and balance.
const PDFDocument = require('pdfkit');
const logo = require('./logo');
const { TYPE_LABEL, fmtMoney: money, fmtDate: date, localized } = require('./billing');
const { tr } = require('../public/i18n');

const COLORS = {
  text: '#1f2933',
  muted: '#616e7c',
  rule: '#d9dee5',
  band: '#f2f4f7',
  accent: '#1d4e89',
  good: '#2f7d32',
  bad: '#b91c1c',
};
const MARGIN = 48;

const fmtQty = (q) => (Number.isInteger(q) ? String(q) : String(Math.round(q * 1000) / 1000));
const cityLine = (x) => [[x.city, x.state].filter(Boolean).join(', '), x.zip].filter(Boolean).join(' ');

/**
 * @param {object} detail   billing.documentDetail()
 * @param {object} settings billing.getSettings()
 * @param {object} options
 * @param {number} options.businessId whose logo to print
 * @param {string} [options.lang]     'en' or 'es': the customer's language
 * @param {string} [options.link]     where the customer can view, approve and pay it online
 * @param {boolean} [options.payOnline] whether that page takes online payment
 * @returns {Promise<Buffer>}
 */
function generateDocument(detail, settings, { businessId, lang = 'en', link, payOnline = false } = {}) {
  const t_ = (text, params) => tr(lang, text, params);
  const fmtMoney = (c) => money(c, lang);
  const fmtDate = (iso) => date(iso, lang);
  const { doc: d, lines, payments, contact, totals: t } = detail;
  const label = t_(TYPE_LABEL[d.type]);
  const pdf = new PDFDocument({ size: 'LETTER', margin: MARGIN, bufferPages: true, info: { Title: `${label} ${d.number}`, Author: settings.company_name } });
  const chunks = [];
  pdf.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });
  const W = pdf.page.width - MARGIN * 2;
  const bottom = () => pdf.page.height - MARGIN - 24;
  const ensure = (h) => {
    if (pdf.y + h > bottom()) {
      pdf.addPage();
      return true;
    }
    return false;
  };

  // ---- Header: logo (or company name) on the left, QUOTE / INVOICE and its number on the right.
  let headerBottom = MARGIN;
  const logoFile = logo.current(businessId);
  if (logoFile) {
    try {
      pdf.image(logoFile.path, MARGIN, MARGIN, { fit: [168, 64] });
      headerBottom = MARGIN + 64;
    } catch {
      // Unreadable logo: the name below instead.
    }
  }
  if (headerBottom === MARGIN) {
    pdf.fillColor(COLORS.accent).font('Helvetica-Bold').fontSize(20).text(settings.company_name, MARGIN, MARGIN, { width: W * 0.55 });
    headerBottom = Math.max(pdf.y, MARGIN + 30);
  }
  pdf.fillColor(COLORS.accent).font('Helvetica-Bold').fontSize(24).text(label.toUpperCase(), MARGIN, MARGIN, { width: W, align: 'right', characterSpacing: 2 });
  pdf.fillColor(COLORS.text).font('Helvetica').fontSize(10).text(`# ${d.number}`, { width: W, align: 'right' });
  const stamp = { paid: [t_('PAID'), COLORS.good], void: [t_('VOID'), COLORS.bad], approved: [t_('APPROVED'), COLORS.good], invoiced: [t_('APPROVED'), COLORS.good], declined: [t_('DECLINED'), COLORS.bad] }[d.display_status];
  if (stamp) pdf.fillColor(stamp[1]).font('Helvetica-Bold').fontSize(11).text(stamp[0], { width: W, align: 'right', characterSpacing: 1 });
  headerBottom = Math.max(headerBottom, pdf.y);
  pdf.moveTo(MARGIN, headerBottom + 8).lineTo(MARGIN + W, headerBottom + 8).lineWidth(2).strokeColor(COLORS.accent).stroke();

  // ---- From / bill to / dates, in three columns.
  const top = headerBottom + 20;
  const colW = (W - 24) / 3;
  const block = (x, heading, rows) => {
    pdf.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(8).text(heading.toUpperCase(), x, top, { width: colW, characterSpacing: 1 });
    pdf.moveDown(0.3);
    rows.filter(Boolean).forEach(([text, bold], i) => {
      pdf.fillColor(COLORS.text).font(bold || i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).text(text, x, pdf.y, { width: colW });
    });
    return pdf.y;
  };
  const from = block(MARGIN, t_('From'), [
    [settings.company_name, true],
    settings.company_address ? [settings.company_address] : null,
    settings.company_phone ? [settings.company_phone] : null,
    settings.company_email ? [settings.company_email] : null,
    settings.company_website ? [settings.company_website] : null,
    settings.license_number ? [t_('License # {n}', { n: settings.license_number })] : null,
  ]);
  const to = block(MARGIN + colW + 12, d.type === 'quote' ? t_('Prepared for') : t_('Bill to'), contact ? [
    [contact.name, true],
    contact.company && contact.company !== contact.name ? [contact.company] : null,
    contact.address ? [contact.address] : null,
    cityLine(contact) ? [cityLine(contact)] : null,
    contact.phone ? [contact.phone] : null,
    contact.email ? [contact.email] : null,
  ] : [['—']]);
  const dates = [
    [t_('Date: {date}', { date: fmtDate(d.issue_date) }), false],
    d.due_date ? [t_(d.type === 'quote' ? 'Valid until: {date}' : 'Due: {date}', { date: fmtDate(d.due_date) })] : null,
    d.quote_number ? [t_('For quote # {n}', { n: d.quote_number })] : null,
  ];
  pdf.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(8).text(t_('DETAILS'), MARGIN + (colW + 12) * 2, top, { width: colW, characterSpacing: 1 });
  pdf.moveDown(0.3);
  dates.filter(Boolean).forEach(([text]) => pdf.fillColor(COLORS.text).font('Helvetica').fontSize(9.5).text(text, MARGIN + (colW + 12) * 2, pdf.y, { width: colW }));
  pdf.fillColor(COLORS.accent).font('Helvetica-Bold').fontSize(13).text(fmtMoney(d.type === 'invoice' && d.display_status !== 'void' ? t.balance : t.total), MARGIN + (colW + 12) * 2, pdf.y + 4, { width: colW });
  pdf.fillColor(COLORS.muted).font('Helvetica').fontSize(8).text(d.type === 'invoice' ? t_('Balance due') : t_('Total'), { width: colW });
  pdf.y = Math.max(from, to, pdf.y) + 14;
  pdf.x = MARGIN;

  if (d.job_address || d.title) {
    pdf.rect(MARGIN, pdf.y, W, 1).fill(COLORS.rule);
    pdf.y += 8;
    if (d.title) pdf.fillColor(COLORS.text).font('Helvetica-Bold').fontSize(12).text(d.title, MARGIN, pdf.y, { width: W });
    if (d.job_address) pdf.fillColor(COLORS.muted).font('Helvetica').fontSize(9.5).text(t_('Job site: {address}', { address: d.job_address }), MARGIN, pdf.y + 2, { width: W });
    pdf.y += 10;
  }

  // ---- Items table. The header repeats on each new page.
  const showTax = t.tax > 0 || (d.tax_rate > 0 && lines.some((l) => l.taxable));
  const cols = { qty: 52, price: 80, amount: 86 };
  const nameW = W - cols.qty - cols.price - cols.amount - 24;
  const xQty = MARGIN + nameW + 8;
  const xPrice = xQty + cols.qty + 8;
  const xAmount = xPrice + cols.price + 8;
  const tableHeader = () => {
    const y = pdf.y;
    pdf.rect(MARGIN, y, W, 20).fill(COLORS.accent);
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5);
    pdf.text(t_('ITEM'), MARGIN + 8, y + 6, { width: nameW - 8, characterSpacing: 0.5 });
    pdf.text(t_('QTY'), xQty, y + 6, { width: cols.qty, align: 'right' });
    pdf.text(t_('PRICE'), xPrice, y + 6, { width: cols.price, align: 'right' });
    pdf.text(t_('AMOUNT'), xAmount, y + 6, { width: cols.amount - 8, align: 'right' });
    pdf.y = y + 26;
  };
  ensure(60);
  tableHeader();
  if (!lines.length) pdf.fillColor(COLORS.muted).font('Helvetica-Oblique').fontSize(9.5).text(t_('No items.'), MARGIN + 8, pdf.y, { width: nameW });
  lines.forEach((l, i) => {
    pdf.font('Helvetica-Bold').fontSize(10);
    const nameH = pdf.heightOfString(l.name, { width: nameW - 8 });
    pdf.font('Helvetica').fontSize(9);
    const descH = l.description ? pdf.heightOfString(l.description, { width: nameW - 8 }) + 2 : 0;
    if (ensure(nameH + descH + 10)) tableHeader();
    const y = pdf.y;
    if (i % 2 === 1) pdf.rect(MARGIN, y - 4, W, nameH + descH + 8).fill(COLORS.band);
    pdf.fillColor(COLORS.text).font('Helvetica-Bold').fontSize(10).text(l.name, MARGIN + 8, y, { width: nameW - 8 });
    if (l.description) pdf.fillColor(COLORS.muted).font('Helvetica').fontSize(9).text(l.description, MARGIN + 8, y + nameH + 2, { width: nameW - 8 });
    pdf.fillColor(COLORS.text).font('Helvetica').fontSize(9.5);
    pdf.text(`${fmtQty(l.quantity)}${l.unit ? ` ${t_(l.unit)}` : ''}`, xQty - 20, y, { width: cols.qty + 20, align: 'right' });
    pdf.text(fmtMoney(l.unit_price), xPrice, y, { width: cols.price, align: 'right' });
    pdf.text(`${fmtMoney(t.line_amounts[i])}${showTax && l.taxable ? ' T' : ''}`, xAmount, y, { width: cols.amount - 8, align: 'right' });
    pdf.y = y + nameH + descH + 8;
  });
  pdf.moveTo(MARGIN, pdf.y).lineTo(MARGIN + W, pdf.y).lineWidth(0.75).strokeColor(COLORS.rule).stroke();
  pdf.y += 8;

  // ---- Totals, right-aligned.
  const rows = [[t_('Subtotal'), fmtMoney(t.subtotal)]];
  if (t.discount) rows.push([d.discount_type === 'percent' ? t_('Discount ({pct}%)', { pct: d.discount_value }) : t_('Discount'), `-${fmtMoney(t.discount)}`]);
  if (showTax) rows.push([t_('Tax ({pct}% on items marked T)', { pct: d.tax_rate }), fmtMoney(t.tax)]);
  rows.push([t_('Total'), fmtMoney(t.total), true]);
  if (d.type === 'quote' && t.deposit) rows.push([t_('Deposit due on approval ({pct}%)', { pct: d.deposit_percent }), fmtMoney(t.deposit)]);
  if (d.type === 'quote' && t.paid) rows.push([t_('Paid'), `-${fmtMoney(t.paid)}`]);
  if (d.type === 'invoice' && t.paid) rows.push([t_('Paid'), `-${fmtMoney(t.paid)}`], [t_('Balance due'), fmtMoney(t.balance), true]);
  ensure(rows.length * 18 + 10);
  const labelW = 200;
  const xLabel = MARGIN + W - labelW - cols.amount;
  for (const [text, value, strong] of rows) {
    const y = pdf.y;
    pdf.fillColor(strong ? COLORS.accent : COLORS.text).font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(strong ? 12 : 10);
    pdf.text(text, xLabel, y, { width: labelW, align: 'right' });
    pdf.text(value, xAmount - 20, y, { width: cols.amount + 12, align: 'right' });
    pdf.y = y + (strong ? 18 : 15);
  }
  pdf.x = MARGIN;

  // ---- Payments received (invoices).
  if (d.type === 'invoice' && payments.length) {
    pdf.y += 10;
    ensure(30 + payments.length * 14);
    heading(t_('Payments received'));
    for (const p of payments) {
      pdf.fillColor(COLORS.text).font('Helvetica').fontSize(9.5)
        .text(`${fmtDate(p.paid_on)}  ·  ${fmtMoney(p.amount)}${p.method ? `  ·  ${t_(p.method)}` : ''}${p.reference ? ` (${p.reference})` : ''}`, MARGIN, pdf.y, { width: W });
    }
  }

  function heading(text) {
    pdf.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(8).text(text.toUpperCase(), MARGIN, pdf.y, { width: W, characterSpacing: 1 });
    pdf.moveDown(0.3);
  }
  const paragraph = (title, text) => {
    if (!text) return;
    pdf.y += 12;
    ensure(40);
    heading(title);
    pdf.fillColor(COLORS.text).font('Helvetica').fontSize(9.5).text(text, MARGIN, pdf.y, { width: W });
  };
  paragraph(t_('Notes'), d.notes);
  if (d.type === 'invoice' && d.display_status !== 'paid' && d.display_status !== 'void') paragraph(t_('How to pay'), localized(settings, 'payment_instructions', lang));
  paragraph(t_('Terms'), d.terms);

  // ---- Approval (quotes).
  if (d.type === 'quote') {
    pdf.y += 18;
    ensure(70);
    heading(t_('Approval'));
    if (d.approved_at) {
      pdf.fillColor(COLORS.good).font('Helvetica-Bold').fontSize(10.5)
        .text(t_('Approved by {name} on {date}.', { name: d.approved_name, date: fmtDate(d.approved_at) }), MARGIN, pdf.y, { width: W });
    } else if (d.declined_at) {
      pdf.fillColor(COLORS.bad).font('Helvetica-Bold').fontSize(10.5).text(t_('Declined on {date}.', { date: fmtDate(d.declined_at) }), MARGIN, pdf.y, { width: W });
    } else {
      pdf.fillColor(COLORS.text).font('Helvetica').fontSize(9.5).text(t_('By signing, I accept this quote and authorize the work described above.'), MARGIN, pdf.y, { width: W });
      const y = pdf.y + 30;
      pdf.moveTo(MARGIN, y).lineTo(MARGIN + W * 0.55, y).moveTo(MARGIN + W * 0.65, y).lineTo(MARGIN + W, y).lineWidth(0.75).strokeColor(COLORS.text).stroke();
      pdf.fillColor(COLORS.muted).fontSize(8).text(t_('Signature'), MARGIN, y + 4).text(t_('Date'), MARGIN + W * 0.65, y + 4);
      pdf.y = y + 18;
      if (link) pdf.fillColor(COLORS.accent).fontSize(9.5).text(t_('Or approve it online'), MARGIN, pdf.y + 4, { link, underline: true });
    }
  } else if (link && !['paid', 'void'].includes(d.display_status)) {
    pdf.y += 12;
    pdf.fillColor(COLORS.accent).font('Helvetica').fontSize(9.5).text(payOnline ? t_('Pay this invoice online') : t_('View this invoice online'), MARGIN, pdf.y, { link, underline: true });
  }

  // ---- Footer on every page.
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    pdf.page.margins.bottom = 0; // footer sits inside the bottom margin
    const y = pdf.page.height - MARGIN + 8;
    pdf.fillColor(COLORS.muted).font('Helvetica').fontSize(8);
    pdf.text(`${settings.company_name ? `${settings.company_name} · ` : ''}${label} ${d.number}`, MARGIN, y, { width: W / 2, lineBreak: false });
    pdf.text(t_('Page {n} of {count}', { n: i - range.start + 1, count: range.count }), MARGIN + W / 2, y, { width: W / 2, align: 'right', lineBreak: false });
  }
  pdf.end();
  return done;
}

module.exports = { generateDocument };
