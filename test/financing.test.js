const { startServer, client, addBusiness, addUser, fakeFetch } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const config = require('../server/config');
const financing = require('../server/financing');

async function setup(t) {
  const { db, server, base } = await startServer();
  const realFetch = financing.transport.fetch;
  t.after(() => {
    server.close();
    financing.transport.fetch = realFetch;
    config.financing.provider = 'test';
    config.financing.wisetack.apiKey = '';
    config.financing.wisetack.webhookSecret = '';
  });
  const b = addBusiness(db, 'Acme Repairs');
  addUser(db, b, 'ada@acme.com', 'Ada', 'admin');
  const admin = client(base);
  await admin.login('ada@acme.com');
  return { db, b, admin, anon: client(base) };
}

/** A $3,000 quote, sent, with its customer link token. */
async function sentQuote(admin, amount = '3000') {
  const contact = (await admin.post('/api/contacts', { name: 'María González', email: 'maria@example.com', phone: '(909) 555-0123', language: 'es' })).data.id;
  const id = (await admin.post('/api/docs', { type: 'quote', contact_id: contact, lines: [{ name: 'New roof', unit_price: amount }] })).data.id;
  await admin.post(`/api/docs/${id}/mark-sent`, {});
  return { id, token: (await admin.get(`/api/docs/${id}`)).data.public_url.split('/view/')[1] };
}

test('financing: offered once a quote is approved, and the lender paying is recorded', async (t) => {
  const { admin, anon } = await setup(t);
  const { id, token } = await sentQuote(admin);
  // Off until the business turns it on.
  assert.strictEqual((await anon.get(`/api/public/docs/${token}`)).data.financing.amount, null);
  await admin.put('/api/settings/financing', { enabled: true });
  assert.strictEqual((await admin.get('/api/meta')).data.financing.ready, true);
  // Not before the quote is approved.
  assert.strictEqual((await anon.get(`/api/public/docs/${token}`)).data.financing.amount, null);
  assert.strictEqual((await anon.post(`/api/public/docs/${token}/finance`)).status, 409);
  await anon.post(`/api/public/docs/${token}/approve`, { name: 'María González' });
  assert.strictEqual((await anon.get(`/api/public/docs/${token}`)).data.financing.amount, 300000);

  // The customer applies; asking again reuses the open application.
  const first = (await anon.post(`/api/public/docs/${token}/finance`, undefined, { 'X-Lang': 'es' })).data.url;
  assert.match(first, new RegExp(`#/finance-test/${token}/\\d+\\?lang=es$`));
  assert.strictEqual((await anon.post(`/api/public/docs/${token}/finance`)).data.url, first);
  const appId = Number(first.match(/\/(\d+)\?/)[1]);

  // The pretend lender approves, the customer accepts, and the lender pays the business.
  assert.strictEqual((await anon.post(`/api/public/finance-test/${token}/${appId}`, { decision: 'nonsense' })).status, 400);
  assert.strictEqual((await anon.post(`/api/public/finance-test/${token}/${appId}`, { decision: 'funded' })).data.status, 'funded');
  const d = (await admin.get(`/api/docs/${id}`)).data;
  assert.strictEqual(d.financing.application.status, 'funded');
  assert.strictEqual(d.payments.length, 1);
  assert.strictEqual(d.payments[0].method, 'Financing');
  assert.strictEqual(d.payments[0].amount, 300000);
  // Each step was a notice: approved, accepted, paid.
  const texts = (await admin.get('/api/notifications')).data.items.map((n) => n.text);
  assert.ok(texts.some((x) => /Financing approved for Q-1001/.test(x)));
  assert.ok(texts.some((x) => /accepted financing/.test(x)));
  assert.ok(texts.some((x) => /The lender paid \$3,000\.00 on Q-1001/.test(x)));
  // Paid in full: nothing more to finance; the invoice made from it is already paid.
  assert.strictEqual((await anon.get(`/api/public/docs/${token}`)).data.financing.amount, null);
  const inv = (await admin.post(`/api/docs/${id}/convert`)).data.id;
  await admin.post(`/api/docs/${inv}/mark-sent`, {});
  assert.strictEqual((await admin.get(`/api/docs/${inv}`)).data.doc.display_status, 'paid');
});

test('financing: amount limits, declined applications and the test lender only in test mode', async (t) => {
  const { admin, anon } = await setup(t);
  await admin.put('/api/settings/financing', { enabled: true });
  const small = await sentQuote(admin, '200');
  await anon.post(`/api/public/docs/${small.token}/approve`, { name: 'X' });
  assert.strictEqual((await anon.get(`/api/public/docs/${small.token}`)).data.financing.amount, null); // under $500
  const big = await sentQuote(admin, '30000');
  await anon.post(`/api/public/docs/${big.token}/approve`, { name: 'X' });
  assert.strictEqual((await anon.get(`/api/public/docs/${big.token}`)).data.financing.amount, null); // over $25,000

  const q = await sentQuote(admin);
  await anon.post(`/api/public/docs/${q.token}/approve`, { name: 'X' });
  const url = (await anon.post(`/api/public/docs/${q.token}/finance`)).data.url;
  const appId = Number(url.match(/\/(\d+)\?/)[1]);
  await anon.post(`/api/public/finance-test/${q.token}/${appId}`, { decision: 'declined' });
  const pub = (await anon.get(`/api/public/docs/${q.token}`)).data;
  assert.strictEqual(pub.financing.application.status, 'declined');
  assert.strictEqual(pub.financing.amount, 300000); // they can try again (or pay another way)
  assert.strictEqual((await admin.get(`/api/docs/${q.id}`)).data.payments.length, 0);

  config.financing.provider = 'wisetack';
  assert.strictEqual((await anon.get(`/api/public/finance-test/${q.token}/${appId}`)).status, 404);
});

test('financing: Wisetack applications, callbacks and status checks', async (t) => {
  const { db, b, admin, anon } = await setup(t);
  config.financing.provider = 'wisetack';
  config.financing.wisetack.apiKey = 'wt_key';
  config.financing.wisetack.webhookSecret = 'wt_secret';
  const fake = fakeFetch([
    ['POST', /\/v1\/merchants\/m_42\/transactions$/, { transactionId: 'wt_tx_1', paymentLink: 'https://wisetack.us/#/abc' }],
    ['GET', /\/v1\/merchants\/m_42\/transactions\/wt_tx_1$/, { transactionId: 'wt_tx_1', status: 'AUTHORIZED' }],
  ]);
  financing.transport.fetch = fake;
  // Needs the business's merchant ID.
  assert.strictEqual((await admin.put('/api/settings/financing', { enabled: true })).status, 400);
  await admin.put('/api/settings/financing', { enabled: true, merchant_id: 'm_42' });
  assert.strictEqual(db.prepare('SELECT wisetack_merchant_id FROM businesses WHERE id = ?').get(b).wisetack_merchant_id, 'm_42');

  const { id, token } = await sentQuote(admin);
  await anon.post(`/api/public/docs/${token}/approve`, { name: 'María' });
  assert.strictEqual((await anon.post(`/api/public/docs/${token}/finance`)).data.url, 'https://wisetack.us/#/abc');
  const sent = JSON.parse(fake.calls[0].body);
  assert.strictEqual(sent.transactionAmount, '3000.00');
  assert.strictEqual(sent.customerFirstName, 'María');
  assert.strictEqual(sent.mobileNumber, '9095550123');
  assert.match(sent.callbackURL, /\/api\/webhooks\/wisetack$/);
  assert.strictEqual(fake.calls[0].headers.Authorization, 'Bearer wt_key');

  // Opening the quote asks Wisetack for the latest status.
  assert.strictEqual((await admin.get(`/api/docs/${id}`)).data.financing.application.status, 'approved');
  // Callbacks need the shared secret; a settled loan records the payment once.
  const callback = (body, auth = 'Bearer wt_secret') => anon.raw('POST', '/api/webhooks/wisetack', JSON.stringify(body), { 'Content-Type': 'application/json', Authorization: auth });
  assert.strictEqual((await callback({ transactionId: 'wt_tx_1', status: 'SETTLED' }, 'Bearer nope')).status, 401);
  assert.strictEqual((await callback({ transactionId: 'wt_tx_1', status: 'SETTLED' })).status, 200);
  assert.strictEqual((await callback({ transactionId: 'wt_tx_1', status: 'SETTLED' })).status, 200);
  const d = (await admin.get(`/api/docs/${id}`)).data;
  assert.strictEqual(d.financing.application.status, 'funded');
  assert.strictEqual(d.payments.length, 1);
  assert.strictEqual(d.payments[0].reference, 'Wisetack');
});
