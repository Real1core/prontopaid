const { startServer, client, addBusiness, addUser, fakeFetch } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const stripe = require('../server/stripe');
const { services } = require('../server/mail');

async function setup(t) {
  const { db, server, base } = await startServer();
  const realFetch = stripe.transport.fetch;
  t.after(() => {
    server.close();
    stripe.transport.fetch = realFetch;
    services.mail = null;
  });
  const b = addBusiness(db, 'Acme Repairs');
  addUser(db, b, 'ada@acme.com', 'Ada', 'admin');
  addUser(db, b, 'sam@acme.com', 'Sam', 'member');
  const admin = client(base);
  await admin.login('ada@acme.com');
  const member = client(base);
  await member.login('sam@acme.com');
  return { db, base, b, admin, member, anon: client(base) };
}

/** Send a signed Stripe webhook, as Stripe would. */
async function webhook(c, event, secret = 'whsec_test') {
  const body = JSON.stringify(event);
  return c.raw('POST', '/api/webhooks/stripe', body, { 'Content-Type': 'application/json', 'Stripe-Signature': stripe.signWebhook(body, secret) });
}

/** An invoice for $500, sent, and its customer link token. */
async function sentInvoice(admin, contact = {}) {
  const contactId = (await admin.post('/api/contacts', { name: 'Pat Owner', email: 'pat@example.com', ...contact })).data.id;
  const id = (await admin.post('/api/docs', { type: 'invoice', contact_id: contactId, lines: [{ name: 'Water heater', unit_price: '500' }] })).data.id;
  await admin.post(`/api/docs/${id}/mark-sent`, {});
  const d = (await admin.get(`/api/docs/${id}`)).data;
  return { id, token: d.public_url.split('/view/')[1] };
}

test('stripe: form encoding and webhook signatures', () => {
  assert.strictEqual(stripe.encode({ a: 1, b: { c: 'x', d: [{ e: 2 }] }, skip: undefined }).toString(), 'a=1&b%5Bc%5D=x&b%5Bd%5D%5B0%5D%5Be%5D=2');
  const body = '{"id":"evt_1"}';
  assert.deepStrictEqual(stripe.verifyWebhook(body, stripe.signWebhook(body, 's1'), ['other', 's1']), { id: 'evt_1' });
  assert.throws(() => stripe.verifyWebhook(body, stripe.signWebhook(body, 'wrong'), ['s1']), /Bad signature/);
  assert.throws(() => stripe.verifyWebhook(body, stripe.signWebhook(body, 's1', Math.floor(Date.now() / 1000) - 3600), ['s1']), /Bad signature/); // too old
  assert.throws(() => stripe.verifyWebhook(body.replace('1', '2'), stripe.signWebhook(body, 's1'), ['s1']), /Bad signature/); // body changed
});

test('connect your bank, then customers pay invoices online by card or bank', async (t) => {
  const { db, b, admin, member, anon } = await setup(t);
  const fake = fakeFetch([
    ['POST', /\/v1\/accounts$/, { id: 'acct_123' }],
    ['POST', /\/v1\/account_links$/, { url: 'https://connect.stripe.com/setup/abc' }],
    ['GET', /\/v1\/accounts\/acct_123$/, { id: 'acct_123', charges_enabled: true, payouts_enabled: true, details_submitted: true }],
    ['POST', /\/v1\/accounts\/acct_123\/login_links$/, { url: 'https://connect.stripe.com/express/xyz' }],
    ['POST', /\/v1\/checkout\/sessions$/, (_url, opts) => ({ id: `cs_${fake.calls.length}`, url: `https://checkout.stripe.com/c/pay/cs_${fake.calls.length}`, body: opts.body })],
  ]);
  stripe.transport.fetch = fake;

  const { id, token } = await sentInvoice(admin, { language: 'es' });
  // Not connected yet: nothing to pay online.
  assert.strictEqual((await anon.get(`/api/public/docs/${token}`)).data.pay.amount, 0);
  assert.strictEqual((await anon.post(`/api/public/docs/${token}/pay`)).status, 409);

  // Only administrators connect the bank.
  assert.strictEqual((await member.post('/api/payments/connect')).status, 403);
  const connect = await admin.post('/api/payments/connect');
  assert.strictEqual(connect.data.url, 'https://connect.stripe.com/setup/abc');
  const accountCall = new URLSearchParams(fake.calls[0].body);
  assert.strictEqual(accountCall.get('type'), 'express');
  assert.strictEqual(accountCall.get('capabilities[transfers][requested]'), 'true');
  assert.strictEqual(fake.calls[0].headers['Idempotency-Key'], `account-${b}`);
  assert.strictEqual(db.prepare('SELECT stripe_account_id FROM businesses WHERE id = ?').get(b).stripe_account_id, 'acct_123');
  // Back from Stripe: the account is checked and ready.
  const status = (await admin.post('/api/payments/connect/sync')).data;
  assert.deepStrictEqual(status, { available: true, connected: true, ready: true, payouts: true, submitted: true });
  assert.strictEqual((await admin.post('/api/payments/dashboard')).data.url, 'https://connect.stripe.com/express/xyz');

  // The customer pays the $500 balance; Stripe's page is in their language and the money goes to the business.
  const pub = (await anon.get(`/api/public/docs/${token}`)).data;
  assert.deepStrictEqual(pub.pay, { amount: 50000, kind: 'balance' });
  const pay = await anon.post(`/api/public/docs/${token}/pay`, undefined, { 'X-Lang': 'es' });
  assert.match(pay.data.url, /^https:\/\/checkout\.stripe\.com\//);
  const session = new URLSearchParams(fake.calls.at(-1).body);
  assert.strictEqual(session.get('mode'), 'payment');
  assert.strictEqual(session.get('locale'), 'es-419');
  assert.strictEqual(session.get('line_items[0][price_data][unit_amount]'), '50000');
  assert.strictEqual(session.get('payment_intent_data[transfer_data][destination]'), 'acct_123');
  assert.strictEqual(session.get('payment_method_types[1]'), 'us_bank_account');
  assert.strictEqual(session.get('customer_email'), 'pat@example.com');
  assert.strictEqual(session.get('metadata[document_id]'), String(id));
  const sessionId = db.prepare('SELECT checkout_session_id FROM online_payments WHERE document_id = ?').get(id).checkout_session_id;

  // A bank payment: Checkout completes unpaid, then clears days later.
  const completed = { type: 'checkout.session.completed', data: { object: { id: sessionId, payment_status: 'unpaid', amount_total: 50000, metadata: { kind: 'document_payment', document_id: String(id) } } } };
  assert.strictEqual((await webhook(anon, completed, 'wrong-secret')).status, 400); // unsigned notices are refused
  assert.strictEqual((await webhook(anon, completed)).status, 200);
  let d = (await admin.get(`/api/docs/${id}`)).data;
  assert.strictEqual(d.pending_payments.length, 1);
  assert.strictEqual(d.online.amount, 0); // not asked for twice while it clears
  assert.strictEqual(d.totals.balance, 50000);
  const cleared = { type: 'checkout.session.async_payment_succeeded', data: { object: { ...completed.data.object, payment_status: 'paid', payment_intent: 'pi_1' } } };
  await webhook(anon, cleared);
  await webhook(anon, cleared); // Stripe may send a notice more than once
  d = (await admin.get(`/api/docs/${id}`)).data;
  assert.strictEqual(d.doc.display_status, 'paid');
  assert.strictEqual(d.payments.length, 1);
  assert.strictEqual(d.payments[0].method, 'Bank transfer (online)');
  assert.strictEqual(d.payments[0].source, 'online');
  assert.strictEqual(d.pending_payments.length, 0);
  // Online payments can't be deleted by hand, and the business heard about it.
  assert.strictEqual((await admin.del(`/api/docs/${id}/payments/${d.payments[0].id}`)).status, 409);
  const bell = (await admin.get('/api/notifications')).data;
  assert.strictEqual(bell.unread, 1);
  assert.match(bell.items[0].text, /Payment received: \$500\.00 on INV-1001/);
});

test('quote deposits are paid online and count toward the invoice; failed bank payments are reported', async (t) => {
  const { db, admin, anon } = await setup(t);
  db.prepare("UPDATE businesses SET stripe_account_id = 'acct_9', stripe_charges_enabled = 1").run();
  stripe.transport.fetch = fakeFetch([['POST', /checkout\/sessions$/, (_u, o) => ({ id: `cs_${Math.random()}`, url: 'https://checkout.stripe.com/x', body: o.body })]]);
  const q = (await admin.post('/api/docs', { type: 'quote', deposit_percent: '25', lines: [{ name: 'Roof', unit_price: '4000' }] })).data.id;
  await admin.post(`/api/docs/${q}/mark-sent`, {});
  const token = (await admin.get(`/api/docs/${q}`)).data.public_url.split('/view/')[1];
  assert.deepStrictEqual((await anon.get(`/api/public/docs/${token}`)).data.pay, { amount: 100000, kind: 'deposit' });
  await anon.post(`/api/public/docs/${token}/pay`);
  const sid = db.prepare('SELECT checkout_session_id FROM online_payments WHERE document_id = ?').get(q).checkout_session_id;
  await webhook(anon, { type: 'checkout.session.completed', data: { object: { id: sid, payment_status: 'paid', amount_total: 100000, metadata: { kind: 'document_payment' } } } });
  assert.strictEqual((await anon.get(`/api/public/docs/${token}`)).data.pay.amount, 0); // deposit done
  // The invoice made from the quote counts the deposit.
  await anon.post(`/api/public/docs/${token}/approve`, { name: 'Pat' });
  const inv = (await admin.post(`/api/docs/${q}/convert`)).data.id;
  await admin.post(`/api/docs/${inv}/mark-sent`, {});
  let d = (await admin.get(`/api/docs/${inv}`)).data;
  assert.strictEqual(d.totals.paid, 100000);
  assert.strictEqual(d.totals.balance, 300000);
  assert.strictEqual(d.doc.display_status, 'partial');
  assert.strictEqual(d.online.amount, 300000);
  // A bank payment for the rest fails.
  const invToken = d.public_url.split('/view/')[1];
  await anon.post(`/api/public/docs/${invToken}/pay`);
  const sid2 = db.prepare('SELECT checkout_session_id FROM online_payments WHERE document_id = ?').get(inv).checkout_session_id;
  await webhook(anon, { type: 'checkout.session.completed', data: { object: { id: sid2, payment_status: 'unpaid', metadata: { kind: 'document_payment' } } } });
  await webhook(anon, { type: 'checkout.session.async_payment_failed', data: { object: { id: sid2, metadata: { kind: 'document_payment' } } } });
  d = (await admin.get(`/api/docs/${inv}`)).data;
  assert.strictEqual(d.totals.balance, 300000);
  assert.strictEqual(d.online.amount, 300000); // can be paid again
  assert.match((await admin.get('/api/notifications')).data.items[0].text, /did not go through/);
  // Turned off on the Get paid tab: no online payment.
  await admin.put('/api/settings', { online_payments: false });
  assert.strictEqual((await anon.get(`/api/public/docs/${invToken}`)).data.pay.amount, 0);
});

test('premium: subscribe through Stripe, and lose it when the subscription ends', async (t) => {
  const { db, b, admin, member, anon } = await setup(t);
  const fake = fakeFetch([
    ['POST', /checkout\/sessions$/, { id: 'cs_prem', url: 'https://checkout.stripe.com/prem' }],
    ['POST', /billing_portal\/sessions$/, { url: 'https://billing.stripe.com/p/abc' }],
  ]);
  stripe.transport.fetch = fake;
  assert.strictEqual((await admin.get('/api/meta')).data.plan.premium, false);
  assert.strictEqual((await member.post('/api/payments/premium/checkout')).status, 403);
  assert.strictEqual((await admin.post('/api/payments/premium/checkout')).data.url, 'https://checkout.stripe.com/prem');
  const params = new URLSearchParams(fake.calls[0].body);
  assert.strictEqual(params.get('mode'), 'subscription');
  assert.strictEqual(params.get('line_items[0][price]'), 'price_premium');
  assert.strictEqual(params.get('client_reference_id'), String(b));

  await webhook(anon, { type: 'checkout.session.completed', data: { object: { id: 'cs_prem', customer: 'cus_1', subscription: 'sub_1', client_reference_id: String(b), metadata: { kind: 'premium', business_id: String(b) } } } });
  let meta = (await admin.get('/api/meta')).data;
  assert.strictEqual(meta.plan.premium, true);
  assert.strictEqual(meta.plan.managed, true);
  assert.strictEqual((await admin.post('/api/payments/premium/portal')).data.url, 'https://billing.stripe.com/p/abc');

  // A missed payment keeps Premium for now (Stripe retries); a canceled subscription ends it.
  await webhook(anon, { type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'past_due' } } });
  assert.strictEqual((await admin.get('/api/meta')).data.plan.premium, true);
  await webhook(anon, { type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled' } } });
  meta = (await admin.get('/api/meta')).data;
  assert.strictEqual(meta.plan.premium, false);
  assert.strictEqual(db.prepare('SELECT subscription_status FROM businesses WHERE id = ?').get(b).subscription_status, 'canceled');
});
