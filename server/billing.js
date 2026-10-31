// Quotes and invoices: customers, a price list, quotes the customer can approve online,
// invoices made from them (or from scratch) and the payments received.
// Every function takes the business it works for (businessId) and only touches its rows.
// Amounts are kept in cents so totals always add up to the penny.
const crypto = require('crypto');
const { HttpError, msg, isoDate, isEmail, sanitizeName } = require('./util');
const { tr, pick, LOCALE } = require('../public/i18n');

const TYPES = ['quote', 'invoice'];
const TYPE_LABEL = { quote: 'Quote', invoice: 'Invoice' };
const CONTACT_KINDS = { client: 'Client', owner: 'Property owner', manager: 'Property manager', contractor: 'Contractor', vendor: 'Vendor', other: 'Other' };
const UNITS = ['each', 'hour', 'day', 'sq ft', 'ln ft', 'job', 'trip', 'gallon'];
const PAYMENT_METHODS = ['Check', 'Cash', 'Card', 'ACH / bank transfer', 'Zelle', 'Other'];
const MANUAL_STATUS = { quote: ['draft', 'sent', 'approved', 'declined'], invoice: ['draft', 'sent', 'void'] };

const STATUS_LABEL = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  approved: 'Approved',
  declined: 'Declined',
  expired: 'Expired',
  invoiced: 'Invoiced',
  partial: 'Partly paid',
  paid: 'Paid',
  overdue: 'Overdue',
  void: 'Void',
};

// ---- Settings ------------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  company_name: '',
  company_address: '',
  company_phone: '',
  company_email: '',
  company_website: '',
  license_number: '',
  tax_rate: 0,
  quote_valid_days: 30,
  invoice_due_days: 30,
  deposit_percent: 0,
  quote_prefix: 'Q-',
  invoice_prefix: 'INV-',
  next_quote_number: 1001,
  next_invoice_number: 1001,
  // Terms and payment instructions in each language; the customer's language is printed.
  quote_terms: 'Prices are for the work listed and are good until the date shown. Any additional work will be quoted separately before it is done.',
  quote_terms_es: 'Los precios son por el trabajo indicado y son válidos hasta la fecha mostrada. Cualquier trabajo adicional se cotizará por separado antes de hacerlo.',
  invoice_terms: 'Payment is due by the date shown. Thank you for your business.',
  invoice_terms_es: 'El pago vence en la fecha indicada. Gracias por su preferencia.',
  payment_instructions: '',
  payment_instructions_es: '',
  // Let customers pay invoices online (card and bank) once Stripe is connected.
  online_payments: true,
};
const NUMBER_SETTINGS = ['tax_rate', 'quote_valid_days', 'invoice_due_days', 'deposit_percent', 'next_quote_number', 'next_invoice_number'];
const BOOLEAN_SETTINGS = ['online_payments'];
const LONG_SETTINGS = ['quote_terms', 'quote_terms_es', 'invoice_terms', 'invoice_terms_es', 'payment_instructions', 'payment_instructions_es'];
const SETTING_LABEL = {
  tax_rate: 'Sales tax %',
  quote_valid_days: 'Quotes valid for (days)',
  invoice_due_days: 'Invoices due in (days)',
  deposit_percent: 'Deposit on quotes %',
  next_quote_number: 'Next quote number',
  next_invoice_number: 'Next invoice number',
};

function getSettings(db, businessId) {
  const saved = Object.fromEntries(db.prepare('SELECT key, value FROM settings WHERE business_id = ?').all(businessId).map((r) => [r.key, JSON.parse(r.value)]));
  return { ...DEFAULT_SETTINGS, ...saved };
}

/** Terms or payment instructions in a language, falling back to English. */
const localized = (settings, key, lang) => (lang === 'es' && settings[`${key}_es`]) || settings[key];

function saveSettings(db, businessId, body) {
  const errors = [];
  const values = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (body[key] === undefined) continue;
    if (NUMBER_SETTINGS.includes(key)) {
      const n = Number(String(body[key]).replace(/[%,\s]/g, '') || 0);
      const whole = key.startsWith('next_') || key.endsWith('_days');
      const pct = key.endsWith('percent') || key === 'tax_rate';
      if (!Number.isFinite(n) || n < 0 || (whole && !Number.isInteger(n)) || (pct ? n > 100 : n > 1e9)) {
        errors.push(pct ? msg('{label} must be a percentage from 0 to 100.', { label: SETTING_LABEL[key] }) : msg('{label} must be a whole number.', { label: SETTING_LABEL[key] }));
      } else values[key] = n;
    } else if (BOOLEAN_SETTINGS.includes(key)) {
      values[key] = body[key] === true || body[key] === 'true' || body[key] === 'on' || body[key] === '1';
    } else {
      values[key] = String(body[key]).trim().slice(0, LONG_SETTINGS.includes(key) ? 4000 : 200);
    }
  }
  if (values.company_name === '') errors.push(msg('Company name is required.'));
  if (values.company_email && !isEmail(values.company_email)) errors.push(msg('Company email is not a valid email address.'));
  if (errors.length) throw new HttpError(400, errors);
  const upsert = db.prepare('INSERT INTO settings (business_id, key, value) VALUES (?, ?, ?) ON CONFLICT(business_id, key) DO UPDATE SET value = excluded.value');
  db.transaction(() => {
    Object.entries(values).forEach(([k, v]) => upsert.run(businessId, k, JSON.stringify(v)));
    if (values.company_name) db.prepare('UPDATE businesses SET name = ? WHERE id = ?').run(values.company_name, businessId);
  })();
  return getSettings(db, businessId);
}

// ---- Money and dates -----------------------------------------------------------------------

/** "$1,234.50", "1234.5" or 1234.5 to 123450 cents. Blank is null; anything else is NaN. */
function toCents(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).replace(/[$,\s]/g, '');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function fmtMoney(cents, lang = 'en') {
  return new Intl.NumberFormat(LOCALE[pick(lang)], { style: 'currency', currency: 'USD' }).format((cents || 0) / 100);
}

/** "October 29, 2026" / "29 de octubre de 2026" from YYYY-MM-DD (or a SQLite timestamp). */
function fmtDate(iso, lang = 'en') {
  if (!iso) return '';
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString(LOCALE[pick(lang)], { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const today = () => isoDate();
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

// ---- Totals and status ---------------------------------------------------------------------

/** Line amounts, discount, tax, total, paid and balance (all in cents). */
function totals(doc, lines, payments = []) {
  const amounts = lines.map((l) => Math.round(l.quantity * l.unit_price));
  const subtotal = amounts.reduce((a, b) => a + b, 0);
  const taxableSubtotal = amounts.reduce((a, amount, i) => a + (lines[i].taxable ? amount : 0), 0);
  let discount = doc.discount_type === 'percent' ? Math.round((subtotal * doc.discount_value) / 100) : Math.round(doc.discount_value * 100);
  discount = Math.max(0, Math.min(discount, Math.max(subtotal, 0)));
  // The discount comes off the taxed and untaxed items in proportion.
  const taxableBase = subtotal > 0 ? taxableSubtotal - Math.round((discount * taxableSubtotal) / subtotal) : taxableSubtotal;
  const tax = Math.round((Math.max(taxableBase, 0) * doc.tax_rate) / 100);
  const total = subtotal - discount + tax;
  const paid = payments.reduce((a, p) => a + p.amount, 0);
  return {
    line_amounts: amounts,
    subtotal,
    discount,
    taxable: taxableBase,
    tax,
    total,
    deposit: doc.type === 'quote' && doc.deposit_percent ? Math.round((total * doc.deposit_percent) / 100) : 0,
    paid,
    balance: total - paid,
  };
}

/** What a list or the customer sees: an overdue invoice, an expired or invoiced quote… */
function displayStatus(doc, t, invoiceId) {
  const now = today();
  if (doc.type === 'quote') {
    if (invoiceId) return 'invoiced';
    if (doc.status === 'sent' && doc.due_date && doc.due_date < now) return 'expired';
    if (doc.status === 'sent' && doc.viewed_at) return 'viewed';
    return doc.status;
  }
  if (doc.status === 'void' || doc.status === 'draft') return doc.status;
  if (t.total > 0 && t.balance <= 0) return 'paid';
  if (doc.due_date && doc.due_date < now) return 'overdue';
  if (t.paid > 0) return 'partial';
  return doc.viewed_at ? 'viewed' : 'sent';
}

// ---- Contacts ------------------------------------------------------------------------------

const CONTACT_FIELDS = ['name', 'company', 'email', 'phone', 'address', 'city', 'state', 'zip', 'notes'];

function contactInput(body) {
  const c = Object.fromEntries(CONTACT_FIELDS.map((k) => [k, String(body[k] ?? '').trim().slice(0, k === 'notes' ? 4000 : 200)]));
  c.kind = CONTACT_KINDS[body.kind] ? body.kind : 'client';
  c.language = pick(body.language);
  c.archived = body.archived ? 1 : 0;
  const errors = [];
  if (!c.name && !c.company) errors.push(msg('Enter a name or a company.'));
  if (!c.name) c.name = c.company;
  if (c.email && !isEmail(c.email)) errors.push(msg('Email is not a valid email address.'));
  if (errors.length) throw new HttpError(400, errors);
  return c;
}

function listContacts(db, businessId, { archived = false } = {}) {
  return db
    .prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM documents WHERE contact_id = c.id) AS document_count
       FROM contacts c WHERE c.business_id = ? AND c.archived = ? ORDER BY c.name COLLATE NOCASE`,
    )
    .all(businessId, archived ? 1 : 0);
}

function saveContact(db, businessId, id, body) {
  const c = contactInput(body);
  const cols = [...CONTACT_FIELDS, 'kind', 'language', 'archived'];
  if (id) {
    if (!db.prepare('SELECT id FROM contacts WHERE id = ? AND business_id = ?').get(id, businessId)) throw new HttpError(404, 'Customer not found.');
    db.prepare(`UPDATE contacts SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => c[k]), id);
    return id;
  }
  return Number(db.prepare(`INSERT INTO contacts (business_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(businessId, ...cols.map((k) => c[k])).lastInsertRowid);
}

function deleteContact(db, businessId, id) {
  if (db.prepare('SELECT 1 FROM documents WHERE contact_id = ? AND business_id = ?').get(id, businessId)) {
    throw new HttpError(409, 'This customer has quotes or invoices. Archive them instead, so those keep their name.');
  }
  db.prepare('DELETE FROM contacts WHERE id = ? AND business_id = ?').run(id, businessId);
}

// ---- Price list ----------------------------------------------------------------------------

function itemInput(body) {
  const name = String(body.name ?? '').trim().slice(0, 200);
  const price = toCents(body.unit_price);
  const errors = [];
  if (!name) errors.push(msg('Item name is required.'));
  if (Number.isNaN(price)) errors.push(msg('Price must be a number.'));
  if (errors.length) throw new HttpError(400, errors);
  return {
    name,
    description: String(body.description ?? '').trim().slice(0, 4000),
    unit: String(body.unit ?? '').trim().slice(0, 30),
    unit_price: price ?? 0,
    taxable: body.taxable ? 1 : 0,
  };
}

const listItems = (db, businessId) => db.prepare('SELECT * FROM catalog_items WHERE business_id = ? ORDER BY name COLLATE NOCASE').all(businessId);

function saveItem(db, businessId, id, body) {
  const item = itemInput(body);
  const cols = Object.keys(item);
  if (id) {
    if (!db.prepare('SELECT id FROM catalog_items WHERE id = ? AND business_id = ?').get(id, businessId)) throw new HttpError(404, 'Item not found.');
    db.prepare(`UPDATE catalog_items SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => item[k]), id);
    return id;
  }
  return Number(db.prepare(`INSERT INTO catalog_items (business_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(businessId, ...cols.map((k) => item[k])).lastInsertRowid);
}

// ---- Quotes and invoices -------------------------------------------------------------------

/** The next unused number, e.g. "Q-1001", moving the counter on. */
function takeNumber(db, businessId, type) {
  const s = getSettings(db, businessId);
  const prefix = s[`${type}_prefix`];
  let n = s[`next_${type}_number`];
  const exists = db.prepare('SELECT 1 FROM documents WHERE business_id = ? AND type = ? AND number = ?');
  while (exists.get(businessId, type, `${prefix}${n}`)) n++;
  saveSettings(db, businessId, { [`next_${type}_number`]: n + 1 });
  return `${prefix}${n}`;
}

function linesInput(lines, errors) {
  if (!Array.isArray(lines)) return [];
  return lines.slice(0, 500).flatMap((l, i) => {
    const name = String(l.name ?? '').trim().slice(0, 300);
    const description = String(l.description ?? '').trim().slice(0, 4000);
    const quantity = Number(String(l.quantity ?? '1').replace(/[,\s]/g, '') || 1);
    const price = toCents(l.unit_price);
    if (!name && !description && !price) return []; // an empty row left in the form
    const n = i + 1;
    if (!name) errors.push(msg('Line {n} needs a name.', { n }));
    if (!Number.isFinite(quantity) || Math.abs(quantity) > 1e7) errors.push(msg('Line {n}: quantity must be a number.', { n }));
    if (Number.isNaN(price) || Math.abs(price ?? 0) > 1e12) errors.push(msg('Line {n}: price must be a number.', { n }));
    return [{ name, description, quantity: Number.isFinite(quantity) ? Math.round(quantity * 1000) / 1000 : 1, unit: String(l.unit ?? '').trim().slice(0, 30), unit_price: price || 0, taxable: l.taxable ? 1 : 0 }];
  });
}

/** Validate and normalize a quote or invoice from the form. */
function documentInput(db, businessId, type, body) {
  const errors = [];
  const text = (k, max = 300) => String(body[k] ?? '').trim().slice(0, max);
  const pct = (k, label) => {
    const n = Number(String(body[k] ?? '').replace(/[%,\s]/g, '') || 0);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      errors.push(msg('{label} must be a percentage from 0 to 100.', { label }));
      return 0;
    }
    return n;
  };
  const contactId = body.contact_id ? Number(body.contact_id) : null;
  if (contactId && !db.prepare('SELECT id FROM contacts WHERE id = ? AND business_id = ?').get(contactId, businessId)) errors.push(msg('Customer not found.'));
  const issue = text('issue_date') || today();
  if (!validDate(issue)) errors.push(msg('Date must be YYYY-MM-DD.'));
  const due = text('due_date');
  if (due && !validDate(due)) errors.push(msg(type === 'quote' ? 'Valid until must be YYYY-MM-DD.' : 'Due date must be YYYY-MM-DD.'));
  const discountType = body.discount_type === 'percent' ? 'percent' : 'amount';
  let discountValue = 0;
  if (discountType === 'percent') discountValue = pct('discount_value', 'Discount');
  else {
    const c = toCents(body.discount_value);
    if (Number.isNaN(c) || c < 0) errors.push(msg('Discount must be a positive amount.'));
    else discountValue = (c || 0) / 100;
  }
  const lines = linesInput(body.lines, errors);
  const doc = {
    contact_id: contactId,
    title: text('title'),
    job_address: text('job_address', 500),
    issue_date: issue,
    due_date: due || null,
    discount_type: discountType,
    discount_value: discountValue,
    tax_rate: pct('tax_rate', 'Tax rate'),
    deposit_percent: type === 'quote' ? pct('deposit_percent', 'Deposit') : 0,
    notes: text('notes', 8000),
    terms: text('terms', 8000),
  };
  if (errors.length) throw new HttpError(400, errors);
  return { doc, lines };
}

function writeLines(db, id, lines) {
  db.prepare('DELETE FROM document_lines WHERE document_id = ?').run(id);
  const insert = db.prepare('INSERT INTO document_lines (document_id, position, name, description, quantity, unit, unit_price, taxable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  lines.forEach((l, i) => insert.run(id, i + 1, l.name, l.description, l.quantity, l.unit, l.unit_price, l.taxable));
}

function insertDocument(db, businessId, type, doc, lines, userId, extra = {}) {
  const row = { ...doc, ...extra, business_id: businessId, type, number: takeNumber(db, businessId, type), public_token: crypto.randomBytes(16).toString('hex'), created_by: userId };
  const cols = Object.keys(row);
  const id = Number(db.prepare(`INSERT INTO documents (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => row[k])).lastInsertRowid);
  writeLines(db, id, lines);
  return id;
}

const contactLanguage = (db, contactId) => (contactId ? db.prepare('SELECT language FROM contacts WHERE id = ?').get(contactId)?.language : null) || 'en';

function createDocument(db, businessId, type, body, user) {
  if (!TYPES.includes(type)) throw new HttpError(400, 'Choose a quote or an invoice.');
  const s = getSettings(db, businessId);
  // Left out entirely (not just blank): the company's defaults, with terms in the customer's language.
  const lang = contactLanguage(db, body.contact_id ? Number(body.contact_id) : null);
  const defaults = { terms: localized(s, `${type}_terms`, lang), tax_rate: s.tax_rate, deposit_percent: type === 'quote' ? s.deposit_percent : 0 };
  for (const [k, v] of Object.entries(defaults)) if (body[k] === undefined) body = { ...body, [k]: v };
  const { doc, lines } = documentInput(db, businessId, type, body);
  if (!doc.due_date) doc.due_date = addDays(doc.issue_date, type === 'quote' ? s.quote_valid_days : s.invoice_due_days);
  return db.transaction(() => insertDocument(db, businessId, type, doc, lines, user.id))();
}

function updateDocument(db, businessId, id, body) {
  const current = db.prepare('SELECT type FROM documents WHERE id = ? AND business_id = ?').get(id, businessId);
  const { doc, lines } = documentInput(db, businessId, current.type, body);
  const cols = Object.keys(doc);
  db.transaction(() => {
    db.prepare(`UPDATE documents SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...cols.map((k) => doc[k]), id);
    writeLines(db, id, lines);
  })();
}

/** A quote or invoice the person may see: their business's; admins see all, members the ones they made. */
function documentForUser(db, id, user) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND business_id = ?').get(id, user.business_id);
  if (!doc) throw new HttpError(404, 'Not found.');
  if (user.role !== 'admin' && doc.created_by !== user.id) throw new HttpError(403, 'This was made by someone else.');
  return doc;
}

/** Payments that count toward a document: an invoice also counts the deposit paid on its quote. */
const paymentsFor = (db, doc) => db.prepare('SELECT * FROM payments WHERE document_id IN (?, ?) ORDER BY paid_on, id').all(doc.id, doc.type === 'invoice' && doc.quote_id ? doc.quote_id : doc.id);

function documentDetail(db, id) {
  const doc = db
    .prepare(
      `SELECT d.*, u.name AS created_by_name, q.number AS quote_number,
         (SELECT id FROM documents WHERE quote_id = d.id AND type = 'invoice' ORDER BY id LIMIT 1) AS invoice_id
       FROM documents d LEFT JOIN users u ON u.id = d.created_by LEFT JOIN documents q ON q.id = d.quote_id AND d.type = 'invoice'
       WHERE d.id = ?`,
    )
    .get(id);
  if (!doc) throw new HttpError(404, 'Not found.');
  if (doc.type === 'invoice') doc.invoice_id = null;
  else doc.quote_number = null;
  if (doc.invoice_id) doc.invoice_number = db.prepare('SELECT number FROM documents WHERE id = ?').get(doc.invoice_id).number;
  const lines = db.prepare('SELECT * FROM document_lines WHERE document_id = ? ORDER BY position').all(id).map((l) => ({ ...l, taxable: Boolean(l.taxable) }));
  const payments = paymentsFor(db, doc);
  const contact = doc.contact_id ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(doc.contact_id) : null;
  const t = totals(doc, lines, payments);
  const status = displayStatus(doc, t, doc.invoice_id);
  const pending = db.prepare("SELECT amount, method, created_at FROM online_payments WHERE document_id = ? AND status = 'processing' ORDER BY id").all(id);
  return { doc: { ...doc, display_status: status, status_label: STATUS_LABEL[status], language: contact ? contact.language : 'en' }, lines, payments, pending_payments: pending, contact, totals: t };
}

/** Quotes or invoices with their totals, for the lists. */
function listDocuments(db, businessId, { type, userId = null } = {}) {
  const docs = db
    .prepare(
      `SELECT d.*, c.name AS contact_name, c.company AS contact_company,
         (SELECT id FROM documents WHERE quote_id = d.id AND type = 'invoice' AND d.type = 'quote' ORDER BY id LIMIT 1) AS invoice_id
       FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
       WHERE d.business_id = ? AND d.type = ? AND (? IS NULL OR d.created_by = ?)
       ORDER BY d.issue_date DESC, d.id DESC`,
    )
    .all(businessId, type, userId, userId);
  if (!docs.length) return [];
  const ids = [...new Set(docs.flatMap((d) => [d.id, d.quote_id].filter(Boolean)))];
  const marks = ids.map(() => '?').join(',');
  const linesBy = new Map();
  for (const l of db.prepare(`SELECT document_id, quantity, unit_price, taxable FROM document_lines WHERE document_id IN (${marks})`).all(...ids)) {
    if (!linesBy.has(l.document_id)) linesBy.set(l.document_id, []);
    linesBy.get(l.document_id).push(l);
  }
  const paymentsBy = new Map();
  for (const p of db.prepare(`SELECT document_id, amount FROM payments WHERE document_id IN (${marks})`).all(...ids)) {
    if (!paymentsBy.has(p.document_id)) paymentsBy.set(p.document_id, []);
    paymentsBy.get(p.document_id).push(p);
  }
  return docs.map((d) => {
    const payments = [...(paymentsBy.get(d.id) || []), ...(d.type === 'invoice' && d.quote_id ? paymentsBy.get(d.quote_id) || [] : [])];
    const t = totals(d, linesBy.get(d.id) || [], payments);
    const status = displayStatus(d, t, d.invoice_id);
    delete d.public_token;
    return { ...d, total: t.total, paid: t.paid, balance: t.balance, display_status: status, status_label: STATUS_LABEL[status] };
  });
}

/** Money waiting to come in, and quotes waiting on the customer. */
function summary(quotes, invoices) {
  const open = invoices.filter((i) => ['sent', 'viewed', 'partial', 'overdue'].includes(i.display_status));
  const overdue = open.filter((i) => i.display_status === 'overdue');
  const pending = quotes.filter((q) => ['sent', 'viewed'].includes(q.display_status));
  const approved = quotes.filter((q) => q.display_status === 'approved');
  const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
  return {
    unpaid: sum(open, 'balance'),
    unpaid_count: open.length,
    overdue: sum(overdue, 'balance'),
    overdue_count: overdue.length,
    quotes_pending: sum(pending, 'total'),
    quotes_pending_count: pending.length,
    approved_to_invoice: sum(approved, 'total'),
    approved_to_invoice_count: approved.length,
  };
}

/** Make an invoice from a quote, with the same customer, job and items. Returns the invoice's id. */
function convertToInvoice(db, businessId, quoteId, user) {
  const quote = db.prepare("SELECT * FROM documents WHERE id = ? AND business_id = ? AND type = 'quote'").get(quoteId, businessId);
  if (!quote) throw new HttpError(404, 'Quote not found.');
  const existing = db.prepare("SELECT id FROM documents WHERE quote_id = ? AND type = 'invoice'").get(quoteId);
  if (existing) return { id: existing.id, existing: true };
  const s = getSettings(db, businessId);
  const lines = db.prepare('SELECT name, description, quantity, unit, unit_price, taxable FROM document_lines WHERE document_id = ? ORDER BY position').all(quoteId);
  const issue = today();
  const doc = {
    contact_id: quote.contact_id,
    title: quote.title,
    job_address: quote.job_address,
    issue_date: issue,
    due_date: addDays(issue, s.invoice_due_days),
    discount_type: quote.discount_type,
    discount_value: quote.discount_value,
    tax_rate: quote.tax_rate,
    deposit_percent: 0,
    notes: quote.notes,
    terms: localized(s, 'invoice_terms', contactLanguage(db, quote.contact_id)),
  };
  return { id: db.transaction(() => insertDocument(db, businessId, 'invoice', doc, lines, user.id, { quote_id: quoteId }))(), existing: false };
}

/** A copy as a new draft, dated today. */
function duplicateDocument(db, businessId, id, user) {
  const d = db.prepare('SELECT * FROM documents WHERE id = ? AND business_id = ?').get(id, businessId);
  const s = getSettings(db, businessId);
  const lines = db.prepare('SELECT name, description, quantity, unit, unit_price, taxable FROM document_lines WHERE document_id = ? ORDER BY position').all(id);
  const issue = today();
  const doc = {
    contact_id: d.contact_id,
    title: d.title,
    job_address: d.job_address,
    issue_date: issue,
    due_date: addDays(issue, d.type === 'quote' ? s.quote_valid_days : s.invoice_due_days),
    discount_type: d.discount_type,
    discount_value: d.discount_value,
    tax_rate: d.tax_rate,
    deposit_percent: d.deposit_percent,
    notes: d.notes,
    terms: d.terms,
  };
  return db.transaction(() => insertDocument(db, businessId, d.type, doc, lines, user.id))();
}

/** Record a status by hand: a quote approved over the phone, an invoice voided… */
function setStatus(db, id, body, user) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  const status = body.status;
  if (!MANUAL_STATUS[doc.type].includes(status)) throw new HttpError(400, 'Unknown status.');
  const name = String(body.name ?? '').trim().slice(0, 200);
  db.prepare(
    `UPDATE documents SET status = ?, updated_at = datetime('now'),
       sent_at = CASE WHEN ? = 'sent' THEN COALESCE(sent_at, datetime('now')) ELSE sent_at END,
       approved_at = CASE WHEN ? = 'approved' THEN datetime('now') ELSE NULL END,
       approved_name = CASE WHEN ? = 'approved' THEN ? ELSE NULL END,
       declined_at = CASE WHEN ? = 'declined' THEN datetime('now') ELSE NULL END,
       decline_reason = CASE WHEN ? = 'declined' THEN ? ELSE NULL END
     WHERE id = ?`,
  ).run(status, status, status, status, name || tr(user.language, 'Recorded by {name}', { name: user.name }), status, status, name || null, id);
}

function markSent(db, id, to) {
  db.prepare(
    `UPDATE documents SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
       sent_at = datetime('now'), sent_to = COALESCE(?, sent_to), updated_at = datetime('now') WHERE id = ?`,
  ).run(to, id);
}

function addPayment(db, id, body, user) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (doc.type !== 'invoice') throw new HttpError(400, 'Payments are recorded on invoices.');
  if (doc.status === 'void') throw new HttpError(409, 'This invoice is void.');
  const amount = toCents(body.amount);
  const paidOn = String(body.paid_on || today()).trim();
  const errors = [];
  if (!amount || Number.isNaN(amount) || amount <= 0) errors.push(msg('Enter the amount received.'));
  if (!validDate(paidOn)) errors.push(msg('Date must be YYYY-MM-DD.'));
  if (errors.length) throw new HttpError(400, errors);
  db.transaction(() => {
    db.prepare('INSERT INTO payments (document_id, amount, paid_on, method, reference, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, amount, paidOn, String(body.method ?? '').trim().slice(0, 50), String(body.reference ?? '').trim().slice(0, 200), user.id,
    );
    // Recording a payment means the customer has the invoice.
    db.prepare("UPDATE documents SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, updated_at = datetime('now') WHERE id = ?").run(id);
  })();
}

/**
 * A payment that arrived on its own: paid online through Stripe, or by the customer's lender.
 * The same externalId is only counted once. Returns true if it was new.
 */
function recordExternalPayment(db, docId, { amount, method, source, externalId, reference = '' }) {
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM payments WHERE external_id = ?').get(externalId)) return false;
    db.prepare('INSERT INTO payments (document_id, amount, paid_on, method, reference, source, external_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(docId, amount, today(), method, reference, source, externalId);
    db.prepare("UPDATE documents SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, updated_at = datetime('now') WHERE id = ?").run(docId);
    return true;
  })();
}

function pdfFilename(detail, lang = 'en') {
  const who = detail.contact ? detail.contact.company || detail.contact.name : detail.doc.job_address || detail.doc.title;
  return `${sanitizeName(`${tr(lang, TYPE_LABEL[detail.doc.type])} ${detail.doc.number}${who ? ` - ${who}` : ''}`)}.pdf`;
}

const publicUrl = (base, doc) => `${base}/#/view/${doc.public_token}`;

module.exports = {
  TYPES,
  TYPE_LABEL,
  CONTACT_KINDS,
  UNITS,
  PAYMENT_METHODS,
  STATUS_LABEL,
  getSettings,
  saveSettings,
  localized,
  toCents,
  fmtMoney,
  fmtDate,
  addDays,
  today,
  totals,
  displayStatus,
  listContacts,
  saveContact,
  deleteContact,
  listItems,
  saveItem,
  createDocument,
  updateDocument,
  documentForUser,
  documentDetail,
  listDocuments,
  summary,
  convertToInvoice,
  duplicateDocument,
  setStatus,
  markSent,
  addPayment,
  recordExternalPayment,
  pdfFilename,
  publicUrl,
};
