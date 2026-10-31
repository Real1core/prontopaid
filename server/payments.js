// Getting paid online: what a customer can pay right now, starting a Stripe Checkout payment, and
// what to do with each Stripe webhook (payments, bank transfers clearing, Premium, connected accounts).
const config = require('./config');
const billing = require('./billing');
const stripe = require('./stripe');
const { notify } = require('./notify');

const MIN_CHARGE = 50; // Stripe's smallest charge: $0.50

/** What the Get paid tab shows about the business's Stripe account. */
function connectStatus(b) {
  return {
    available: config.stripeEnabled,
    connected: Boolean(b.stripe_account_id),
    ready: Boolean(b.stripe_charges_enabled),
    payouts: Boolean(b.stripe_payouts_enabled),
    submitted: Boolean(b.stripe_details_submitted),
  };
}

/**
 * How much the customer can pay online on this quote or invoice now: an invoice's balance, or a
 * quote's deposit. Money already on its way (a bank payment that hasn't cleared) isn't asked for again.
 * @returns {{amount: number, kind: 'balance'|'deposit'|null, processing: number}}
 */
function payable(db, business, detail) {
  const none = { amount: 0, kind: null, processing: 0 };
  if (!config.stripeEnabled || !business.stripe_charges_enabled) return none;
  if (!billing.getSettings(db, business.id).online_payments) return none;
  const { doc, totals } = detail;
  const processing = db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM online_payments WHERE document_id = ? AND status = 'processing'").get(doc.id).n;
  let amount = 0;
  let kind = null;
  if (doc.type === 'invoice' && ['sent', 'viewed', 'partial', 'overdue'].includes(doc.display_status)) {
    amount = totals.balance - processing;
    kind = 'balance';
  } else if (doc.type === 'quote' && totals.deposit && ['sent', 'viewed', 'approved'].includes(doc.display_status)) {
    amount = totals.deposit - totals.paid - processing;
    kind = 'deposit';
  }
  return amount >= MIN_CHARGE ? { amount, kind, processing } : { ...none, processing };
}

/** Start a Stripe Checkout payment for what's payable; returns the page to send the customer to. */
async function startCheckout(db, business, detail, { base, lang }) {
  const { amount, kind } = payable(db, business, detail);
  if (!amount) return null;
  const { doc, contact } = detail;
  const link = `${base}/#/view/${doc.public_token}`;
  const label = `${billing.TYPE_LABEL[doc.type]} ${doc.number}${kind === 'deposit' ? ' (deposit)' : ''}`;
  const session = await stripe.createPaymentCheckout({
    business,
    doc,
    amount,
    description: label,
    lang,
    email: contact?.email,
    successUrl: `${link}?paid=1&lang=${lang}`,
    cancelUrl: `${link}?lang=${lang}`,
  });
  db.prepare('INSERT INTO online_payments (document_id, checkout_session_id, amount) VALUES (?, ?, ?)').run(doc.id, session.id, amount);
  return session.url;
}

// ---- Webhooks ------------------------------------------------------------------------------

/** Record a finished online payment once, and tell the business. */
async function paymentSucceeded(db, session, method, base) {
  const row = db.prepare('SELECT * FROM online_payments WHERE checkout_session_id = ?').get(session.id);
  if (!row) return;
  db.prepare("UPDATE online_payments SET status = 'succeeded', method = ?, updated_at = datetime('now') WHERE id = ?").run(method, row.id);
  const isNew = billing.recordExternalPayment(db, row.document_id, {
    amount: session.amount_total ?? row.amount,
    method,
    source: 'online',
    externalId: `stripe_${session.id}`,
    reference: String(session.payment_intent || session.id),
  });
  if (!isNew) return;
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(row.document_id);
  await notify(db, doc.business_id, {
    kind: 'paid',
    text: 'Payment received: {amount} on {number}',
    params: { amount: billing.fmtMoney(session.amount_total ?? row.amount), number: doc.number },
    link: `#/doc/${doc.id}`,
    base,
    only: { userId: doc.created_by },
  });
}

async function paymentFailed(db, session, base) {
  const row = db.prepare('SELECT * FROM online_payments WHERE checkout_session_id = ?').get(session.id);
  if (!row) return;
  db.prepare("UPDATE online_payments SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(row.id);
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(row.document_id);
  await notify(db, doc.business_id, {
    kind: 'payment_failed',
    text: 'A bank payment of {amount} on {number} did not go through',
    params: { amount: billing.fmtMoney(row.amount), number: doc.number },
    link: `#/doc/${doc.id}`,
    base,
    only: { userId: doc.created_by },
  });
}

function setPremium(db, businessId, { customerId, subscriptionId, status }) {
  const premium = stripe.PREMIUM_STATUSES.includes(status);
  db.prepare(`UPDATE businesses SET plan = ?, subscription_status = ?,
      stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE id = ?`)
    .run(premium ? 'premium' : 'free', status, customerId || null, subscriptionId || null, businessId);
  // Without Premium the landing page goes offline (its settings are kept for when they come back).
}

/** Act on one verified Stripe event. Unknown events are ignored. */
async function handleEvent(db, event, base) {
  const o = event.data && event.data.object;
  if (!o) return;
  switch (event.type) {
    case 'checkout.session.completed': {
      if (o.metadata?.kind === 'premium') {
        setPremium(db, Number(o.metadata.business_id || o.client_reference_id), { customerId: o.customer, subscriptionId: o.subscription, status: 'active' });
      } else if (o.metadata?.kind === 'document_payment') {
        // Cards are paid at once; a bank (ACH) payment takes a few business days to clear.
        if (o.payment_status === 'paid') await paymentSucceeded(db, o, 'Card (online)', base);
        else db.prepare("UPDATE online_payments SET status = 'processing', method = 'Bank transfer (online)', updated_at = datetime('now') WHERE checkout_session_id = ?").run(o.id);
      }
      break;
    }
    case 'checkout.session.async_payment_succeeded':
      if (o.metadata?.kind === 'document_payment') await paymentSucceeded(db, o, 'Bank transfer (online)', base);
      break;
    case 'checkout.session.async_payment_failed':
      if (o.metadata?.kind === 'document_payment') await paymentFailed(db, o, base);
      break;
    case 'checkout.session.expired':
      db.prepare("UPDATE online_payments SET status = 'expired', updated_at = datetime('now') WHERE checkout_session_id = ? AND status = 'open'").run(o.id);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const business = db.prepare('SELECT id FROM businesses WHERE stripe_subscription_id = ? OR stripe_customer_id = ? OR id = ?')
        .get(o.id, o.customer, Number(o.metadata?.business_id) || -1);
      if (business) setPremium(db, business.id, { customerId: o.customer, subscriptionId: o.id, status: event.type === 'customer.subscription.deleted' ? 'canceled' : o.status });
      break;
    }
    case 'account.updated': {
      const f = stripe.accountFlags(o);
      db.prepare('UPDATE businesses SET stripe_charges_enabled = ?, stripe_payouts_enabled = ?, stripe_details_submitted = ? WHERE stripe_account_id = ?')
        .run(f.stripe_charges_enabled, f.stripe_payouts_enabled, f.stripe_details_submitted, o.id);
      break;
    }
    default:
      break;
  }
}

module.exports = { MIN_CHARGE, connectStatus, payable, startCheckout, handleEvent };
