// Stripe: how businesses get paid and how ProntoPaid charges for Premium.
//
// - Getting paid uses Stripe Connect (Express accounts). A business taps "Connect your bank" and
//   finishes Stripe's own sign-up, where Stripe verifies them and takes their bank details; the
//   app never sees the bank account number. Customers then pay invoices (or a quote's deposit) on
//   a Stripe Checkout page by card or bank transfer (ACH), and the money goes to the business's
//   account and on to their bank (a "destination charge"), less ProntoPaid's fee if one is set.
// - Premium is a Stripe Billing subscription on ProntoPaid's own account.
// Stripe tells the app what happened through signed webhooks (see routes/payments.js).
const crypto = require('crypto');
const config = require('./config');
const { HttpError } = require('./util');

const API = 'https://api.stripe.com/v1';
// Tests replace this with a fake.
const transport = { fetch: (...args) => globalThis.fetch(...args) };

/** Stripe's form encoding: {a: {b: 1}, c: [x, y]} -> a[b]=1&c[0]=x&c[1]=y */
function encode(params, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') encode(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

async function request(method, path, params, { idempotencyKey } = {}) {
  if (!config.stripeEnabled) throw new HttpError(503, "Payments aren't set up on this server yet.");
  const headers = { Authorization: `Bearer ${config.stripe.secretKey}` };
  let url = API + path;
  let body;
  if (method === 'GET') {
    const q = encode(params).toString();
    if (q) url += `?${q}`;
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = encode(params).toString();
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  }
  const res = await transport.fetch(url, { method, headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Stripe ${method} ${path} failed (${res.status}): ${data.error?.message || 'unknown error'}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---- Connect: the business's own account and bank -----------------------------------------

/** A new Express account for a business. Stripe collects their details and bank on its own page. */
function createAccount(business, email) {
  return request('POST', '/accounts', {
    type: 'express',
    country: 'US',
    email,
    business_profile: { name: business.name },
    capabilities: { card_payments: { requested: true }, transfers: { requested: true }, us_bank_account_ach_payments: { requested: true } },
    metadata: { business_id: business.id },
  }, { idempotencyKey: `account-${business.id}` });
}

/** The link to Stripe's sign-up (or to finish it). Links expire after a few minutes, so make one per tap. */
function onboardingLink(accountId, { refreshUrl, returnUrl }) {
  return request('POST', '/account_links', { account: accountId, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding' });
}

const getAccount = (accountId) => request('GET', `/accounts/${encodeURIComponent(accountId)}`);

/** A one-time link into the business's Stripe Express dashboard: payouts, bank, tax forms. */
const dashboardLink = (accountId) => request('POST', `/accounts/${encodeURIComponent(accountId)}/login_links`, {});

/** The flags the app keeps from a Stripe account. */
const accountFlags = (a) => ({
  stripe_charges_enabled: a.charges_enabled ? 1 : 0,
  stripe_payouts_enabled: a.payouts_enabled ? 1 : 0,
  stripe_details_submitted: a.details_submitted ? 1 : 0,
});

// ---- Customers paying ----------------------------------------------------------------------

/**
 * A Stripe Checkout page where the customer pays an invoice or a deposit by card or bank.
 * @param {object} p
 * @param {object} p.business   needs stripe_account_id
 * @param {object} p.doc        the quote or invoice
 * @param {number} p.amount     in cents
 * @param {string} p.description shown on the page, e.g. "Invoice INV-1001"
 * @param {string} p.lang       'en' or 'es'
 * @param {string} [p.email]    the customer's email, filled in for them
 * @param {string} p.successUrl
 * @param {string} p.cancelUrl
 */
function createPaymentCheckout({ business, doc, amount, description, lang, email, successUrl, cancelUrl }) {
  const fee = config.stripe.platformFeePercent > 0 ? Math.round((amount * config.stripe.platformFeePercent) / 100) : 0;
  const metadata = { kind: 'document_payment', business_id: business.id, document_id: doc.id };
  return request('POST', '/checkout/sessions', {
    mode: 'payment',
    locale: lang === 'es' ? 'es-419' : 'en',
    customer_email: email || undefined,
    payment_method_types: ['card', 'us_bank_account'],
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: amount, product_data: { name: `${business.name} · ${description}` } } }],
    payment_intent_data: {
      description: `${business.name} · ${description}`,
      application_fee_amount: fee || undefined,
      transfer_data: { destination: business.stripe_account_id },
      metadata,
    },
    metadata,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

// ---- Premium -------------------------------------------------------------------------------

function createPremiumCheckout({ business, email, successUrl, cancelUrl }) {
  if (!config.stripe.premiumPriceId) throw new HttpError(503, "Premium isn't set up on this server yet.");
  return request('POST', '/checkout/sessions', {
    mode: 'subscription',
    customer: business.stripe_customer_id || undefined,
    customer_email: business.stripe_customer_id ? undefined : email,
    client_reference_id: business.id,
    line_items: [{ price: config.stripe.premiumPriceId, quantity: 1 }],
    subscription_data: { metadata: { business_id: business.id } },
    metadata: { kind: 'premium', business_id: business.id },
    allow_promotion_codes: true,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

/** Stripe's page where a business updates its card, sees receipts or cancels Premium. */
const billingPortal = (customerId, returnUrl) => request('POST', '/billing_portal/sessions', { customer: customerId, return_url: returnUrl });

const PREMIUM_STATUSES = ['active', 'trialing', 'past_due'];

// ---- Webhooks ------------------------------------------------------------------------------

/**
 * Check a webhook's Stripe-Signature header against the raw body, and parse it.
 * Accepts any of the given secrets (the account's endpoint and the Connect endpoint have their own).
 */
function verifyWebhook(rawBody, header, secrets, toleranceSeconds = 300) {
  const parts = Object.fromEntries(String(header || '').split(',').map((kv) => kv.split('=')).filter((kv) => kv.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const signatures = String(header || '').split(',').filter((kv) => kv.trim().startsWith('v1=')).map((kv) => kv.trim().slice(3));
  const timestamp = Number(parts.t);
  if (!timestamp || !signatures.length) throw new HttpError(400, 'Bad signature.');
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) throw new HttpError(400, 'Bad signature.');
  const ok = secrets.filter(Boolean).some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    return signatures.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  });
  if (!ok) throw new HttpError(400, 'Bad signature.');
  return JSON.parse(rawBody);
}

/** A signature header for a body, as Stripe would send it (for tests and local trials). */
function signWebhook(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

module.exports = {
  transport,
  encode,
  createAccount,
  onboardingLink,
  getAccount,
  dashboardLink,
  accountFlags,
  createPaymentCheckout,
  createPremiumCheckout,
  billingPortal,
  PREMIUM_STATUSES,
  verifyWebhook,
  signWebhook,
};
