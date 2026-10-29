// Quotes and invoices: customers, a price list, quotes the customer can approve online,
// invoices made from them (or from scratch) and the payments received.
// Amounts are kept in cents so totals always add up to the penny.
const crypto = require('crypto');
const { HttpError, isoDate, isEmail, sanitizeName } = require('./util');

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
  quote_terms: 'Prices are for the work listed and are good until the date shown. Any additional work will be quoted separately before it is done.',
  invoice_terms: 'Payment is due by the date shown. Thank you for your business.',
  payment_instructions: '',
};
const NUMBER_SETTINGS = ['tax_rate', 'quote_valid_days', 'invoice_due_days', 'deposit_percent', 'next_quote_number', 'next_invoice_number'];

function getSettings(db) {
  const saved = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, JSON.parse(r.value)]));
  return { ...DEFAULT_SETTINGS, ...saved };
}

function saveSettings(db, body) {
  const errors = [];
  const values = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (body[key] === undefined) continue;
    if (NUMBER_SETTINGS.includes(key)) {
      const n = Number(String(body[key]).replace(/[%,\s]/g, '') || 0);
      const whole = key.startsWith('next_') || key.endsWith('_days');
      if (!Number.isFinite(n) || n < 0 || (whole && !Number.isInteger(n)) || (key.endsWith('percent') || key === 'tax_rate' ? n > 100 : n > 1e9)) {
        errors.push(`${key.replace(/_/g, ' ')} must be a ${whole ? 'whole ' : ''}number${key === 'tax_rate' || key.endsWith('percent') ? ' from 0 to 100' : ''}.`);
      } else values[key] = n;
    } else {
      values[key] = String(body[key]).trim().slice(0, key.endsWith('terms') || key === 'payment_instructions' ? 4000 : 200);
    }
  }
  if (values.company_name === '') errors.push('Company name is required.');
  if (values.company_email && !isEmail(values.company_email)) errors.push('Company email is not a valid email address.');
  if (errors.length) throw new HttpError(400, errors.join(' '));
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => Object.entries(values).forEach(([k, v]) => upsert.run(k, JSON.stringify(v))))();
  return getSettings(db);
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

function fmtMoney(cents) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((cents || 0) / 100);
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
  c.archived = body.archived ? 1 : 0;
  const errors = [];
  if (!c.name && !c.company) errors.push('Enter a name or a company.');
  if (!c.name) c.name = c.company;
  if (c.email && !isEmail(c.email)) errors.push('Email is not a valid email address.');
  if (errors.length) throw new HttpError(400, errors.join(' '));
  return c;
}

function listContacts(db, { archived = false } = {}) {
  return db
    .prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM documents WHERE contact_id = c.id) AS document_count
       FROM contacts c WHERE c.archived = ? ORDER BY c.name COLLATE NOCASE`,
    )
    .all(archived ? 1 : 0);
}

function saveContact(db, id, body) {
  const c = contactInput(body);
  const cols = [...CONTACT_FIELDS, 'kind', 'archived'];
  if (id) {
    if (!db.prepare('SELECT id FROM contacts WHERE id = ?').get(id)) throw new HttpError(404, 'Customer not found.');
    db.prepare(`UPDATE contacts SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => c[k]), id);
    return id;
  }
  return Number(db.prepare(`INSERT INTO contacts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => c[k])).lastInsertRowid);
}

// ---- Price list ----------------------------------------------------------------------------

function itemInput(body) {
  const name = String(body.name ?? '').trim().slice(0, 200);
  const price = toCents(body.unit_price);
  const errors = [];
  if (!name) errors.push('Item name is required.');
  if (Number.isNaN(price)) errors.push('Price must be a number.');
  if (errors.length) throw new HttpError(400, errors.join(' '));
  return {
    name,
    description: String(body.description ?? '').trim().slice(0, 4000),
    unit: String(body.unit ?? '').trim().slice(0, 30),
    unit_price: price ?? 0,
    taxable: body.taxable ? 1 : 0,
  };
}

const listItems = (db) => db.prepare('SELECT * FROM catalog_items ORDER BY name COLLATE NOCASE').all();

function saveItem(db, id, body) {
  const item = itemInput(body);
  const cols = Object.keys(item);
  if (id) {
    if (!db.prepare('SELECT id FROM catalog_items WHERE id = ?').get(id)) throw new HttpError(404, 'Item not found.');
    db.prepare(`UPDATE catalog_items SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => item[k]), id);
    return id;
  }
  return Number(db.prepare(`INSERT INTO catalog_items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => item[k])).lastInsertRowid);
}

// ---- Quotes and invoices -------------------------------------------------------------------

/** The next unused number, e.g. "Q-1001", moving the counter on. */
function takeNumber(db, type) {
  const s = getSettings(db);
  const prefix = s[`${type}_prefix`];
  let n = s[`next_${type}_number`];
  const exists = db.prepare('SELECT 1 FROM documents WHERE type = ? AND number = ?');
  while (exists.get(type, `${prefix}${n}`)) n++;
  saveSettings(db, { [`next_${type}_number`]: n + 1 });
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
    if (!name) errors.push(`Line ${i + 1} needs a name.`);
    if (!Number.isFinite(quantity) || Math.abs(quantity) > 1e7) errors.push(`Line ${i + 1}: quantity must be a number.`);
    if (Number.isNaN(price) || Math.abs(price ?? 0) > 1e12) errors.push(`Line ${i + 1}: price must be a number.`);
    return [{ name, description, quantity: Number.isFinite(quantity) ? Math.round(quantity * 1000) / 1000 : 1, unit: String(l.unit ?? '').trim().slice(0, 30), unit_price: price || 0, taxable: l.taxable ? 1 : 0 }];
  });
}

/** Validate and normalize a quote or invoice from the form. */
function documentInput(db, type, body) {
  const errors = [];
  const text = (k, max = 300) => String(body[k] ?? '').trim().slice(0, max);
  const pct = (k, label) => {
    const n = Number(String(body[k] ?? '').replace(/[%,\s]/g, '') || 0);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      errors.push(`${label} must be a percentage from 0 to 100.`);
      return 0;
    }
    return n;
  };
  const contactId = body.contact_id ? Number(body.contact_id) : null;
  if (contactId && !db.prepare('SELECT id FROM contacts WHERE id = ?').get(contactId)) errors.push('Customer not found.');
  const issue = text('issue_date') || today();
  if (!validDate(issue)) errors.push('Date must be YYYY-MM-DD.');
  const due = text('due_date');
  if (due && !validDate(due)) errors.push(`${type === 'quote' ? 'Valid until' : 'Due date'} must be YYYY-MM-DD.`);
  const discountType = body.discount_type === 'percent' ? 'percent' : 'amount';
  let discountValue = 0;
  if (discountType === 'percent') discountValue = pct('discount_value', 'Discount');
  else {
    const c = toCents(body.discount_value);
    if (Number.isNaN(c) || c < 0) errors.push('Discount must be a positive amount.');
    else discountValue = (c || 0) / 100;
  }
  const lines = linesInput(body.lines, errors);
  if (errors.length) throw new HttpError(400, errors.join(' '));
  return {
    doc: {
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
    },
    lines,
  };
}

function writeLines(db, id, lines) {
  db.prepare('DELETE FROM document_lines WHERE document_id = ?').run(id);
  const insert = db.prepare('INSERT INTO document_lines (document_id, position, name, description, quantity, unit, unit_price, taxable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  lines.forEach((l, i) => insert.run(id, i + 1, l.name, l.description, l.quantity, l.unit, l.unit_price, l.taxable));
}

function insertDocument(db, type, doc, lines, userId, extra = {}) {
  const row = { ...doc, ...extra, type, number: takeNumber(db, type), public_token: crypto.randomBytes(16).toString('hex'), created_by: userId };
  const cols = Object.keys(row);
  const id = Number(db.prepare(`INSERT INTO documents (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => row[k])).lastInsertRowid);
  writeLines(db, id, lines);
  return id;
}

function createDocument(db, type, body, user) {
  if (!TYPES.includes(type)) throw new HttpError(400, 'Choose a quote or an invoice.');
  const s = getSettings(db);
  // Left out entirely (not just blank): the company's defaults.
  const defaults = { terms: s[`${type}_terms`], tax_rate: s.tax_rate, deposit_percent: type === 'quote' ? s.deposit_percent : 0 };
  for (const [k, v] of Object.entries(defaults)) if (body[k] === undefined) body = { ...body, [k]: v };
  const { doc, lines } = documentInput(db, type, body);
  if (!doc.due_date) doc.due_date = addDays(doc.issue_date, type === 'quote' ? s.quote_valid_days : s.invoice_due_days);
  return db.transaction(() => insertDocument(db, type, doc, lines, user.id))();
}

function updateDocument(db, id, body) {
  const current = db.prepare('SELECT type FROM documents WHERE id = ?').get(id);
  const { doc, lines } = documentInput(db, current.type, body);
  const cols = Object.keys(doc);
  db.transaction(() => {
    db.prepare(`UPDATE documents SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...cols.map((k) => doc[k]), id);
    writeLines(db, id, lines);
  })();
}

/** A quote or invoice the person may see: admins see all, everyone else the ones they made. */
function documentForUser(db, id, user) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!doc) throw new HttpError(404, 'Not found.');
  if (user.role !== 'admin' && doc.created_by !== user.id) throw new HttpError(403, 'This was made by someone else.');
  return doc;
}

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
  const payments = db.prepare('SELECT * FROM payments WHERE document_id = ? ORDER BY paid_on, id').all(id);
  const contact = doc.contact_id ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(doc.contact_id) : null;
  const t = totals(doc, lines, payments);
  const status = displayStatus(doc, t, doc.invoice_id);
  return { doc: { ...doc, display_status: status, status_label: STATUS_LABEL[status] }, lines, payments, contact, totals: t };
}

/** Quotes or invoices with their totals, for the lists. */
function listDocuments(db, { type, userId = null } = {}) {
  const docs = db
    .prepare(
      `SELECT d.*, c.name AS contact_name, c.company AS contact_company,
         (SELECT id FROM documents WHERE quote_id = d.id AND type = 'invoice' AND d.type = 'quote' ORDER BY id LIMIT 1) AS invoice_id
       FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
       WHERE d.type = ? AND (? IS NULL OR d.created_by = ?)
       ORDER BY d.issue_date DESC, d.id DESC`,
    )
    .all(type, userId, userId);
  if (!docs.length) return [];
  const ids = docs.map((d) => d.id);
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
    const t = totals(d, linesBy.get(d.id) || [], paymentsBy.get(d.id) || []);
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
  const month = today().slice(0, 7);
  return {
    unpaid: sum(open, 'balance'),
    unpaid_count: open.length,
    overdue: sum(overdue, 'balance'),
    overdue_count: overdue.length,
    quotes_pending: sum(pending, 'total'),
    quotes_pending_count: pending.length,
    approved_to_invoice: sum(approved, 'total'),
    approved_to_invoice_count: approved.length,
    paid_this_month: invoices.filter((i) => i.display_status === 'paid' && (i.updated_at || '').slice(0, 7) === month).length,
  };
}

/** Make an invoice from a quote, with the same customer, job and items. Returns the invoice's id. */
function convertToInvoice(db, quoteId, user) {
  const quote = db.prepare("SELECT * FROM documents WHERE id = ? AND type = 'quote'").get(quoteId);
  if (!quote) throw new HttpError(404, 'Quote not found.');
  const existing = db.prepare("SELECT id FROM documents WHERE quote_id = ? AND type = 'invoice'").get(quoteId);
  if (existing) return { id: existing.id, existing: true };
  const s = getSettings(db);
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
    terms: s.invoice_terms,
  };
  return { id: db.transaction(() => insertDocument(db, 'invoice', doc, lines, user.id, { quote_id: quoteId }))(), existing: false };
}

/** A copy as a new draft, dated today. */
function duplicateDocument(db, id, user) {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  const s = getSettings(db);
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
  return db.transaction(() => insertDocument(db, d.type, doc, lines, user.id))();
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
  ).run(status, status, status, status, name || `Recorded by ${user.name}`, status, status, name || null, id);
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
  if (!amount || Number.isNaN(amount) || amount <= 0) errors.push('Enter the amount received.');
  if (!validDate(paidOn)) errors.push('Date must be YYYY-MM-DD.');
  if (errors.length) throw new HttpError(400, errors.join(' '));
  db.transaction(() => {
    db.prepare('INSERT INTO payments (document_id, amount, paid_on, method, reference, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, amount, paidOn, String(body.method ?? '').trim().slice(0, 50), String(body.reference ?? '').trim().slice(0, 200), user.id,
    );
    // Recording a payment means the customer has the invoice.
    db.prepare("UPDATE documents SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, updated_at = datetime('now') WHERE id = ?").run(id);
  })();
}

function pdfFilename(detail) {
  const who = detail.contact ? detail.contact.company || detail.contact.name : detail.doc.job_address || detail.doc.title;
  return `${sanitizeName(`${TYPE_LABEL[detail.doc.type]} ${detail.doc.number}${who ? ` - ${who}` : ''}`)}.pdf`;
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
  toCents,
  fmtMoney,
  addDays,
  totals,
  displayStatus,
  listContacts,
  saveContact,
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
  pdfFilename,
  publicUrl,
};
