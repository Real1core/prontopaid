const { startServer, client, addUser } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const billing = require('../server/billing');
const { services } = require('../server/routes/billing');

async function setup(t) {
  const { db, server, base } = await startServer();
  t.after(() => {
    server.close();
    services.mail = null;
  });
  addUser(db, 'a@co.com', 'Ada Admin', 'admin');
  addUser(db, 'lee@co.com', 'Lee Field');
  addUser(db, 'oz@co.com', 'Oz Other');
  db.prepare("INSERT INTO settings (key, value) VALUES ('company_name', '\"Acme Repairs\"')").run();
  const admin = client(base);
  await admin.login('a@co.com');
  const lee = client(base);
  await lee.login('lee@co.com');
  const oz = client(base);
  await oz.login('oz@co.com');
  const anon = client(base);
  return { db, admin, lee, oz, anon };
}

const QUOTE = {
  type: 'quote',
  title: 'Bathroom repairs',
  job_address: '2465 N Del Rosa Avenue',
  tax_rate: '8.75',
  discount_type: 'percent',
  discount_value: '10',
  lines: [
    { name: 'Replace toilet', description: 'Remove old, install new', quantity: '1', unit: 'each', unit_price: '$450.00', taxable: true },
    { name: 'Labor', quantity: '2.5', unit: 'hour', unit_price: '75' },
    { name: '', description: '', unit_price: '' }, // an empty row left in the form is dropped
  ],
};

test('billing: totals add up to the penny, with the discount spread over taxed and untaxed items', () => {
  const doc = { type: 'quote', discount_type: 'percent', discount_value: 10, tax_rate: 8.75, deposit_percent: 25 };
  const t = billing.totals(doc, [{ quantity: 1, unit_price: 45000, taxable: 1 }, { quantity: 2.5, unit_price: 7500, taxable: 0 }]);
  assert.strictEqual(t.subtotal, 63750);
  assert.strictEqual(t.discount, 6375);
  assert.strictEqual(t.taxable, 45000 - 4500);
  assert.strictEqual(t.tax, Math.round(40500 * 0.0875));
  assert.strictEqual(t.total, 63750 - 6375 + 3544);
  assert.strictEqual(t.deposit, Math.round(t.total * 0.25));
  assert.strictEqual(billing.toCents('$1,234.565'), 123457);
  assert.ok(Number.isNaN(billing.toCents('abc')));
  // A fixed discount can't make the total negative.
  assert.strictEqual(billing.totals({ discount_type: 'amount', discount_value: 999, tax_rate: 0 }, [{ quantity: 1, unit_price: 1000 }]).total, 0);
});

test('billing: quote → customer approves online → invoice → payments', async (t) => {
  const { db, admin, lee, oz, anon } = await setup(t);
  const contact = await lee.post('/api/contacts', { name: 'Pat Owner', kind: 'owner', email: 'pat@example.com' });
  assert.strictEqual(contact.status, 201);
  assert.strictEqual((await lee.post('/api/contacts', { name: '' })).status, 400);

  assert.strictEqual((await lee.post('/api/docs', { ...QUOTE, lines: [{ name: 'x', unit_price: 'lots' }] })).status, 400);
  const { id } = (await lee.post('/api/docs', { ...QUOTE, contact_id: contact.data.id })).data;
  let d = (await lee.get(`/api/docs/${id}`)).data;
  assert.strictEqual(d.doc.number, 'Q-1001');
  assert.strictEqual(d.doc.display_status, 'draft');
  assert.strictEqual(d.lines.length, 2);
  assert.strictEqual(d.totals.total, 60919);
  assert.match(d.doc.terms, /good until the date shown/); // the company's default terms
  assert.ok(d.doc.due_date > d.doc.issue_date);

  // Only the person who made it and admins see it.
  assert.strictEqual((await oz.get(`/api/docs/${id}`)).status, 403);
  assert.strictEqual((await oz.get('/api/docs')).data.quotes.length, 0);
  assert.strictEqual((await admin.get('/api/docs')).data.quotes.length, 1);

  // The customer's link doesn't work while it's a draft.
  const token = d.public_url.split('/view/')[1];
  assert.strictEqual((await anon.get(`/api/public/docs/${token}`)).status, 404);

  // Email isn't set up: the app says so and the link is sent another way.
  assert.strictEqual((await lee.post(`/api/docs/${id}/send`, { to: 'pat@example.com' })).status, 409);
  const sent = [];
  services.mail = async (mail) => sent.push(mail);
  assert.strictEqual((await lee.post(`/api/docs/${id}/send`, { to: 'not-an-email' })).status, 400);
  assert.strictEqual((await lee.post(`/api/docs/${id}/send`, { to: 'pat@example.com', message: 'Hi <Pat>' })).status, 200);
  assert.deepStrictEqual(sent[0].to, ['pat@example.com']);
  assert.match(sent[0].subject, /^Quote Q-1001 from Acme Repairs: Bathroom repairs$/);
  assert.match(sent[0].html, /Hi &lt;Pat&gt;/);
  assert.ok(sent[0].html.includes(`#/view/${token}`));
  assert.strictEqual(sent[0].attachments[0].name, 'Quote Q-1001 - Pat Owner.pdf');
  assert.strictEqual(sent[0].attachments[0].content.subarray(0, 4).toString(), '%PDF');

  // The customer opens it, without signing in.
  const pub = await anon.get(`/api/public/docs/${token}`);
  assert.strictEqual(pub.status, 200);
  assert.strictEqual(pub.data.doc.can_respond, true);
  assert.strictEqual(pub.data.totals.total, 60919);
  assert.strictEqual(pub.data.contact.name, 'Pat Owner');
  assert.strictEqual(pub.data.public_token, undefined);
  assert.strictEqual((await lee.get(`/api/docs/${id}`)).data.doc.display_status, 'viewed');
  assert.strictEqual((await anon.get(`/api/public/docs/${token}/pdf`)).headers.get('content-type'), 'application/pdf');

  // …and approves it with their name. Whoever made it gets an email.
  assert.strictEqual((await anon.post(`/api/public/docs/${token}/approve`, { name: ' ' })).status, 400);
  assert.strictEqual((await anon.post(`/api/public/docs/${token}/approve`, { name: 'Pat Owner' })).status, 200);
  assert.strictEqual((await anon.post(`/api/public/docs/${token}/decline`, {})).status, 409);
  assert.deepStrictEqual(sent[1].to, ['lee@co.com']);
  assert.match(sent[1].subject, /Quote Q-1001 approved/);
  d = (await lee.get(`/api/docs/${id}`)).data;
  assert.strictEqual(d.doc.display_status, 'approved');
  assert.strictEqual(d.doc.approved_name, 'Pat Owner');

  // Make the invoice: same customer and items, its own number. Doing it twice gives the same one.
  const conv = (await lee.post(`/api/docs/${id}/convert`)).data;
  assert.strictEqual(conv.existing, false);
  assert.deepStrictEqual((await lee.post(`/api/docs/${id}/convert`)).data, { id: conv.id, existing: true });
  let inv = (await lee.get(`/api/docs/${conv.id}`)).data;
  assert.strictEqual(inv.doc.number, 'INV-1001');
  assert.strictEqual(inv.doc.quote_number, 'Q-1001');
  assert.strictEqual(inv.totals.total, 60919);
  assert.strictEqual(inv.contact.name, 'Pat Owner');
  assert.strictEqual((await lee.get(`/api/docs/${id}`)).data.doc.display_status, 'invoiced');

  // Payments: part, then the rest.
  assert.strictEqual((await lee.post(`/api/docs/${conv.id}/payments`, { amount: '0' })).status, 400);
  assert.strictEqual((await lee.post(`/api/docs/${id}/payments`, { amount: '10' })).status, 400); // not on quotes
  await lee.post(`/api/docs/${conv.id}/payments`, { amount: '200', method: 'Check', reference: '1042', paid_on: '2026-10-20' });
  inv = (await lee.get(`/api/docs/${conv.id}`)).data;
  assert.strictEqual(inv.doc.display_status, 'partial'); // recording a payment also marks the draft as sent
  assert.strictEqual(inv.totals.balance, 40919);
  let list = (await lee.get('/api/docs')).data;
  assert.strictEqual(list.summary.unpaid, 40919);
  assert.strictEqual(list.summary.approved_to_invoice_count, 0);
  await lee.post(`/api/docs/${conv.id}/payments`, { amount: '409.19', method: 'Zelle' });
  inv = (await lee.get(`/api/docs/${conv.id}`)).data;
  assert.strictEqual(inv.doc.display_status, 'paid');
  assert.strictEqual(inv.totals.balance, 0);
  list = (await lee.get('/api/docs')).data;
  assert.strictEqual(list.summary.unpaid, 0);
  assert.strictEqual(list.invoices[0].public_token, undefined);

  // The customer can't be deleted while quotes or invoices use them.
  assert.strictEqual((await admin.del(`/api/contacts/${contact.data.id}`)).status, 409);
  assert.ok(db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(contact.data.id));
});

test('billing: overdue, void, declined and status changes by hand', async (t) => {
  const { admin, anon } = await setup(t);
  const inv = (await admin.post('/api/docs', { type: 'invoice', issue_date: '2026-01-01', due_date: '2026-01-31', lines: [{ name: 'Cleaning', unit_price: '350' }] })).data.id;
  assert.strictEqual((await admin.get(`/api/docs/${inv}`)).data.doc.display_status, 'draft');
  await admin.post(`/api/docs/${inv}/mark-sent`, {});
  let list = (await admin.get('/api/docs')).data;
  assert.strictEqual(list.invoices[0].display_status, 'overdue');
  assert.strictEqual(list.summary.overdue, 35000);
  await admin.post(`/api/docs/${inv}/status`, { status: 'void' });
  list = (await admin.get('/api/docs')).data;
  assert.strictEqual(list.invoices[0].display_status, 'void');
  assert.strictEqual(list.summary.unpaid, 0);
  assert.strictEqual((await admin.post(`/api/docs/${inv}/payments`, { amount: '1' })).status, 409);
  assert.strictEqual((await admin.post(`/api/docs/${inv}/status`, { status: 'approved' })).status, 400);

  const q = (await admin.post('/api/docs', { type: 'quote', lines: [{ name: 'Paint', quantity: '400', unit: 'sq ft', unit_price: '2.50' }] })).data.id;
  const { public_url } = (await admin.get(`/api/docs/${q}`)).data;
  await admin.post(`/api/docs/${q}/mark-sent`, { to: 'x@example.com' });
  const token = public_url.split('/view/')[1];
  assert.strictEqual((await anon.post(`/api/public/docs/${token}/decline`, { reason: 'Too much' })).status, 200);
  let d = (await admin.get(`/api/docs/${q}`)).data.doc;
  assert.strictEqual(d.display_status, 'declined');
  assert.strictEqual(d.decline_reason, 'Too much');
  // Approved over the phone after all.
  await admin.post(`/api/docs/${q}/status`, { status: 'approved', name: 'Approved by phone' });
  d = (await admin.get(`/api/docs/${q}`)).data.doc;
  assert.strictEqual(d.display_status, 'approved');
  assert.strictEqual(d.declined_at, null);

  // Duplicate: a new draft with the next number.
  const copy = (await admin.post(`/api/docs/${q}/duplicate`)).data.id;
  const c = (await admin.get(`/api/docs/${copy}`)).data;
  assert.strictEqual(c.doc.number, 'Q-1002');
  assert.strictEqual(c.doc.display_status, 'draft');
  assert.strictEqual(c.totals.total, 100000);

  const pdf = await admin.get(`/api/docs/${q}/pdf?download=1`);
  assert.strictEqual(pdf.data.subarray(0, 4).toString(), '%PDF');
  assert.match(pdf.headers.get('content-disposition'), /^attachment; filename="Quote Q-1001.pdf"$/);

  await admin.del(`/api/docs/${q}`);
  assert.strictEqual((await anon.get(`/api/public/docs/${token}`)).status, 404);
});

test('billing: company settings, numbering and the price list', async (t) => {
  const { admin, lee } = await setup(t);
  assert.strictEqual((await lee.put('/api/settings', { company_name: 'X' })).status, 403);
  assert.strictEqual((await admin.put('/api/settings', { tax_rate: '150' })).status, 400);
  const s = (await admin.put('/api/settings', { company_name: 'Acme Maintenance', tax_rate: '7.75', quote_prefix: 'RQ', next_quote_number: '500', deposit_percent: '30' })).data;
  assert.strictEqual(s.tax_rate, 7.75);
  const id = (await lee.post('/api/docs', { type: 'quote', lines: [{ name: 'A', unit_price: '100', taxable: true }] })).data.id;
  const d = (await lee.get(`/api/docs/${id}`)).data;
  assert.strictEqual(d.doc.number, 'RQ500');
  assert.strictEqual(d.doc.tax_rate, 7.75);
  assert.strictEqual(d.totals.deposit, Math.round(10775 * 0.3));
  assert.strictEqual((await lee.get('/api/meta')).data.settings.next_quote_number, 501);

  assert.strictEqual((await lee.post('/api/items', { name: '', unit_price: '5' })).status, 400);
  const item = (await lee.post('/api/items', { name: 'Service call', unit_price: '$95', unit: 'trip' })).data.id;
  await lee.put(`/api/items/${item}`, { name: 'Service call', unit_price: '105', unit: 'trip', taxable: false });
  const items = (await lee.get('/api/items')).data;
  assert.strictEqual(items[0].unit_price, 10500);
});
