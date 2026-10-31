// Customer financing: once a quote is approved, or on an unpaid invoice, the customer can apply
// to pay over time. A lender checks them (ProntoPaid never makes lending decisions) and, if the
// customer accepts the loan, pays the business; the app then records that payment.
//
// Providers (FINANCING_PROVIDER):
// - "wisetack": Wisetack, the lender Joist and similar apps use. Needs a partner agreement; each
//   business enrolls as a Wisetack merchant and enters its merchant ID on the Get paid tab.
//   Wisetack's partner API is documented privately for partners, so the request and response
//   field names below are kept together in WISETACK and must be checked against those docs.
// - "test": a pretend lender inside the app, to try the whole flow before signing with a lender.
const config = require('./config');
const { HttpError } = require('./util');
const billing = require('./billing');

const STATUSES = ['started', 'pending', 'approved', 'accepted', 'funded', 'declined', 'expired', 'canceled'];
const OPEN = ['started', 'pending', 'approved', 'accepted'];
const STATUS_LABEL = {
  started: 'Application started',
  pending: 'Lender needs more information',
  approved: 'Approved',
  accepted: 'Loan accepted',
  funded: 'Paid by lender',
  declined: 'Not approved',
  expired: 'Expired',
  canceled: 'Canceled',
};

// Tests replace this with a fake.
const transport = { fetch: (...args) => globalThis.fetch(...args) };

// ---- Wisetack ------------------------------------------------------------------------------
// TO CONFIRM WITH WISETACK'S PARTNER DOCS before going live: the paths, field names and
// statuses here follow Wisetack's published overview (create a transaction for a merchant, send
// the customer its payment link, follow its status by callback). Everything Wisetack-specific
// is in this object.
const WISETACK = {
  createPath: (merchantId) => `/v1/merchants/${encodeURIComponent(merchantId)}/transactions`,
  statusPath: (merchantId, id) => `/v1/merchants/${encodeURIComponent(merchantId)}/transactions/${encodeURIComponent(id)}`,
  requestBody: ({ amount, purpose, contact, reference, callbackUrl }) => ({
    transactionAmount: (amount / 100).toFixed(2),
    purpose,
    customerFirstName: contact?.name?.split(/\s+/)[0] || undefined,
    customerLastName: contact?.name?.split(/\s+/).slice(1).join(' ') || undefined,
    email: contact?.email || undefined,
    mobileNumber: contact?.phone ? contact.phone.replace(/\D/g, '').slice(-10) : undefined,
    externalReferenceId: reference,
    callbackURL: callbackUrl,
  }),
  // From the create response: Wisetack's id for the transaction and the customer's link.
  readCreated: (data) => ({ id: data.transactionId || data.id, url: data.paymentLink || data.paymentLinkUrl || data.url }),
  // From a callback or status response.
  readStatus: (data) => ({ id: data.transactionId || data.id, status: data.status || data.transactionStatus }),
  // Wisetack's statuses -> the app's.
  statusMap: {
    INITIATED: 'started',
    ACTIONS_REQUIRED: 'pending',
    AUTHORIZED: 'approved',
    LOAN_TERMS_ACCEPTED: 'accepted',
    LOAN_CONFIRMED: 'accepted',
    SETTLED: 'funded',
    DECLINED: 'declined',
    EXPIRED: 'expired',
    CANCELED: 'canceled',
    CANCELLED: 'canceled',
    REFUNDED: 'canceled',
  },
};

async function wisetackRequest(method, path, body) {
  const { apiUrl, apiKey } = config.financing.wisetack;
  if (!apiKey) throw new HttpError(503, "Financing isn't set up on this server yet.");
  const res = await transport.fetch(apiUrl + path, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Wisetack ${method} ${path} failed (${res.status}): ${data.message || data.error || 'unknown error'}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const mapWisetackStatus = (s) => WISETACK.statusMap[String(s || '').toUpperCase().replace(/\s+/g, '_')] || null;

// ---- Availability --------------------------------------------------------------------------

/** Whether this business can offer financing on this server at all. */
function providerReady(business) {
  const p = config.financing.provider;
  if (!p || !business.financing_enabled) return false;
  if (p === 'test') return true;
  return Boolean(config.financing.wisetack.apiKey && business.wisetack_merchant_id);
}

/**
 * The amount a customer could finance on this quote or invoice right now, or null with why not.
 * Quotes: once approved. Invoices: while money is owed.
 */
function financeable(business, detail) {
  if (!providerReady(business)) return { amount: null, reason: 'off' };
  const { doc, totals } = detail;
  const okStatus = doc.type === 'quote' ? ['approved', 'invoiced'].includes(doc.display_status) : ['sent', 'viewed', 'partial', 'overdue'].includes(doc.display_status);
  if (!okStatus) return { amount: null, reason: 'status' };
  const amount = doc.type === 'quote' ? totals.total - totals.paid : totals.balance;
  if (amount < config.financing.minAmount * 100) return { amount: null, reason: 'too_small' };
  if (amount > config.financing.maxAmount * 100) return { amount: null, reason: 'too_large' };
  return { amount, reason: null };
}

const latestApplication = (db, docId) => db.prepare('SELECT * FROM financing_applications WHERE document_id = ? ORDER BY id DESC LIMIT 1').get(docId) || null;

// ---- Applying ------------------------------------------------------------------------------

/**
 * Start (or reopen) a customer's application and return where to send them.
 * An application still open for the same amount is reused instead of starting another.
 */
async function apply(db, business, detail, { base, lang }) {
  const { amount } = financeable(business, detail);
  if (!amount) throw new HttpError(409, "Financing isn't available for this right now.");
  const open = latestApplication(db, detail.doc.id);
  if (open && OPEN.includes(open.status) && open.amount === amount && open.apply_url) return open;
  const provider = config.financing.provider;
  const appId = Number(db.prepare('INSERT INTO financing_applications (business_id, document_id, provider, amount) VALUES (?, ?, ?, ?)')
    .run(business.id, detail.doc.id, provider, amount).lastInsertRowid);
  let externalId;
  let url;
  if (provider === 'test') {
    externalId = `test_${appId}`;
    url = `${base}/#/finance-test/${detail.doc.public_token}/${appId}?lang=${lang}`;
  } else {
    try {
      const created = WISETACK.readCreated(await wisetackRequest('POST', WISETACK.createPath(business.wisetack_merchant_id), WISETACK.requestBody({
        amount,
        purpose: `${detail.doc.type === 'quote' ? 'Quote' : 'Invoice'} ${detail.doc.number}${detail.doc.title ? ` - ${detail.doc.title}` : ''}`.slice(0, 200),
        contact: detail.contact,
        reference: `pp_${appId}`,
        callbackUrl: `${base}/api/webhooks/wisetack`,
      })));
      externalId = created.id;
      url = created.url;
    } catch (err) {
      db.prepare("UPDATE financing_applications SET status = 'canceled', provider_status = ? WHERE id = ?").run(String(err.message).slice(0, 200), appId);
      console.error(err);
      throw new HttpError(502, "The lender couldn't be reached. Please try again in a few minutes.");
    }
  }
  db.prepare("UPDATE financing_applications SET external_id = ?, apply_url = ?, updated_at = datetime('now') WHERE id = ?").run(externalId, url, appId);
  return db.prepare('SELECT * FROM financing_applications WHERE id = ?').get(appId);
}

/**
 * The lender's news about an application. When the lender has paid, the payment is recorded on
 * the quote or invoice (once). Returns {app, changed, funded}.
 */
function updateStatus(db, appId, status, providerStatus) {
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown status.');
  const app = db.prepare('SELECT * FROM financing_applications WHERE id = ?').get(appId);
  if (!app) throw new HttpError(404, 'Not found.');
  if (app.status === status) return { app, changed: false, funded: false };
  db.prepare("UPDATE financing_applications SET status = ?, provider_status = ?, updated_at = datetime('now') WHERE id = ?").run(status, providerStatus || status, appId);
  let funded = false;
  if (status === 'funded') {
    funded = billing.recordExternalPayment(db, app.document_id, {
      amount: app.amount,
      method: 'Financing',
      source: 'financing',
      externalId: `financing_${app.provider}_${app.external_id || app.id}`,
      reference: app.provider === 'wisetack' ? 'Wisetack' : 'Test lender',
    });
  }
  return { app: { ...app, status }, changed: true, funded };
}

/** Find an application by the lender's own id (from a callback). */
const byExternalId = (db, provider, externalId) => db.prepare('SELECT * FROM financing_applications WHERE provider = ? AND external_id = ?').get(provider, String(externalId)) || null;

/** Ask Wisetack for the latest status (when the business opens the quote, in case a callback was missed). */
async function refresh(db, business, app) {
  if (app.provider !== 'wisetack' || !OPEN.includes(app.status) || !app.external_id || !business.wisetack_merchant_id) return app;
  try {
    const { status } = WISETACK.readStatus(await wisetackRequest('GET', WISETACK.statusPath(business.wisetack_merchant_id, app.external_id)));
    const mapped = mapWisetackStatus(status);
    if (mapped) updateStatus(db, app.id, mapped, status);
  } catch (err) {
    console.error(err);
  }
  return db.prepare('SELECT * FROM financing_applications WHERE id = ?').get(app.id);
}

module.exports = { WISETACK, transport, STATUSES, OPEN, STATUS_LABEL, providerReady, financeable, latestApplication, apply, updateStatus, byExternalId, refresh, mapWisetackStatus };
