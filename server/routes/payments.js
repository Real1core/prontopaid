// Connecting a business's bank through Stripe, Premium, and the webhooks Stripe and the lender
// send. The webhook routes are mounted before the JSON body parser: Stripe's signature covers
// the raw body exactly as sent.
const express = require('express');
const config = require('../config');
const { requireAdmin } = require('../auth');
const { HttpError, baseUrl } = require('../util');
const stripe = require('../stripe');
const payments = require('../payments');
const financing = require('../financing');
const { notify } = require('../notify');

function paymentsRouter(db) {
  const router = express.Router();
  router.use(requireAdmin);
  const back = (req, query) => `${baseUrl(req)}/#/?tab=getpaid${query ? `&${query}` : ''}`;

  /** The business's Stripe account, made the first time. */
  async function account(req) {
    const b = req.business;
    if (b.stripe_account_id) return b.stripe_account_id;
    const acct = await stripe.createAccount(b, req.user.email);
    db.prepare('UPDATE businesses SET stripe_account_id = ? WHERE id = ?').run(acct.id, b.id);
    return acct.id;
  }

  // "Connect your bank": Stripe's own sign-up, where they verify the business and add its bank.
  router.post('/connect', async (req, res) => {
    const link = await stripe.onboardingLink(await account(req), { refreshUrl: `${baseUrl(req)}/api/payments/connect/refresh`, returnUrl: back(req, 'connected=1') });
    res.json({ url: link.url });
  });

  // Stripe sends people here when an onboarding link has expired: make a fresh one.
  router.get('/connect/refresh', async (req, res) => {
    const link = await stripe.onboardingLink(await account(req), { refreshUrl: `${baseUrl(req)}/api/payments/connect/refresh`, returnUrl: back(req, 'connected=1') });
    res.redirect(link.url);
  });

  // Back from Stripe (or to check again): read the account's state.
  router.post('/connect/sync', async (req, res) => {
    const b = req.business;
    if (!b.stripe_account_id) return res.json(payments.connectStatus(b));
    const f = stripe.accountFlags(await stripe.getAccount(b.stripe_account_id));
    db.prepare('UPDATE businesses SET stripe_charges_enabled = ?, stripe_payouts_enabled = ?, stripe_details_submitted = ? WHERE id = ?')
      .run(f.stripe_charges_enabled, f.stripe_payouts_enabled, f.stripe_details_submitted, b.id);
    res.json(payments.connectStatus({ ...b, ...f }));
  });

  // The business's Stripe dashboard: payouts, bank account, tax forms.
  router.post('/dashboard', async (req, res) => {
    if (!req.business.stripe_account_id) throw new HttpError(409, 'Connect your bank first.');
    res.json({ url: (await stripe.dashboardLink(req.business.stripe_account_id)).url });
  });

  // ---- Premium --------------------------------------------------------------------------
  router.post('/premium/checkout', async (req, res) => {
    const session = await stripe.createPremiumCheckout({
      business: req.business,
      email: req.user.email,
      successUrl: `${baseUrl(req)}/#/?tab=site&premium=1`,
      cancelUrl: `${baseUrl(req)}/#/?tab=site`,
    });
    res.json({ url: session.url });
  });

  router.post('/premium/portal', async (req, res) => {
    if (!req.business.stripe_customer_id) throw new HttpError(409, 'There is no subscription to manage yet.');
    res.json({ url: (await stripe.billingPortal(req.business.stripe_customer_id, `${baseUrl(req)}/#/?tab=site`)).url });
  });

  return router;
}

function webhookRouter(db) {
  const router = express.Router();

  router.post('/stripe', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const event = stripe.verifyWebhook(raw, req.get('stripe-signature'), [config.stripe.webhookSecret, config.stripe.connectWebhookSecret]);
    await payments.handleEvent(db, event, baseUrl(req));
    res.json({ received: true });
  });

  // The lender's news about an application. Checked with the shared secret Wisetack is given
  // for ProntoPaid's callback (TO CONFIRM: Wisetack's partner docs name the header and scheme).
  router.post('/wisetack', express.json(), async (req, res) => {
    const secret = config.financing.wisetack.webhookSecret;
    if (!secret || req.get('authorization') !== `Bearer ${secret}`) throw new HttpError(401, 'Bad signature.');
    const { id, status } = financing.WISETACK.readStatus(req.body || {});
    const app = id ? financing.byExternalId(db, 'wisetack', id) : null;
    const mapped = financing.mapWisetackStatus(status);
    if (app && mapped) await financingChanged(db, app, mapped, status, baseUrl(req));
    res.json({ received: true });
  });

  return router;
}

/** Update an application and tell the business when something worth knowing happened. */
async function financingChanged(db, app, status, providerStatus, base) {
  const { changed } = financing.updateStatus(db, app.id, status, providerStatus);
  if (!changed || !['approved', 'accepted', 'funded', 'declined'].includes(status)) return;
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(app.document_id);
  const text = {
    approved: 'Financing approved for {number}',
    accepted: 'Your customer accepted financing for {number}',
    funded: 'The lender paid {amount} on {number}',
    declined: 'Financing was not approved for {number}',
  }[status];
  const { fmtMoney } = require('../billing');
  await notify(db, doc.business_id, { kind: 'financing', text, params: { number: doc.number, amount: fmtMoney(app.amount) }, link: `#/doc/${doc.id}`, base, only: { userId: doc.created_by } });
}

module.exports = { paymentsRouter, webhookRouter, financingChanged };
