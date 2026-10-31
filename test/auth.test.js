const { startServer, client, addBusiness, addUser } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');

/** A small PNG, as a data URL. */
function pngDataUrl() {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 4 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(12, 0x40)])));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

test('sign-up: each new business gets its own administrator, settings and data', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);
  assert.deepStrictEqual((await c.get('/auth/me')).data, { user: null, business: null });
  assert.strictEqual((await c.get('/api/docs')).status, 401);
  const bad = await c.post('/auth/signup', { company_name: 'Acme', name: 'Ada', email: 'ada@acme.com', password: 'short' }, { 'X-Lang': 'es' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.data.error, 'Use una contraseña de al menos 8 caracteres.'); // errors in the person's language
  assert.strictEqual((await c.post('/auth/signup', { company_name: 'Acme', name: 'Ada', email: 'ada@acme.com', password: 'longenough', language: 'es' })).status, 201);
  const me = (await c.get('/auth/me')).data;
  assert.strictEqual(me.user.role, 'admin');
  assert.strictEqual(me.user.language, 'es');
  assert.strictEqual(me.business.name, 'Acme');
  const meta = (await c.get('/api/meta')).data;
  assert.strictEqual(meta.settings.company_name, 'Acme');
  assert.strictEqual(meta.settings.company_email, 'ada@acme.com');
  // The same email can't sign up twice.
  assert.strictEqual((await client(base).post('/auth/signup', { company_name: 'X', name: 'X', email: 'ADA@acme.com', password: 'longenough' })).status, 409);

  // A second business sees none of the first one's customers, quotes or team, even by id.
  const quote = (await c.post('/api/docs', { type: 'quote', lines: [{ name: 'Work', unit_price: '100' }] })).data.id;
  const customer = (await c.post('/api/contacts', { name: 'Pat' })).data.id;
  const other = client(base);
  await other.post('/auth/signup', { company_name: 'Bolt Electric', name: 'Bo', email: 'bo@bolt.com', password: 'longenough' });
  assert.strictEqual((await other.get('/api/docs')).data.quotes.length, 0);
  assert.strictEqual((await other.get('/api/contacts')).data.length, 0);
  assert.strictEqual((await other.get('/api/team')).data.length, 1);
  assert.strictEqual((await other.get(`/api/docs/${quote}`)).status, 404);
  assert.strictEqual((await other.put(`/api/contacts/${customer}`, { name: 'Hijacked' })).status, 404);
  assert.strictEqual((await other.post('/api/docs', { type: 'quote', contact_id: customer })).status, 400);
  // Each business numbers its own quotes from the start.
  const theirs = (await other.post('/api/docs', { type: 'quote', lines: [{ name: 'Panel', unit_price: '900' }] })).data.id;
  assert.strictEqual((await other.get(`/api/docs/${theirs}`)).data.doc.number, 'Q-1001');
  assert.strictEqual((await c.get(`/api/docs/${quote}`)).data.doc.number, 'Q-1001');
  // The language switch.
  await c.put('/auth/language', { language: 'en' });
  assert.strictEqual((await c.get('/auth/me')).data.user.language, 'en');
});

test('auth: sign in, wrong passwords, team members and turning an account off', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => server.close());
  const b = addBusiness(db);
  addUser(db, b, 'ada@acme.com', 'Ada', 'admin');
  const admin = client(base);
  assert.strictEqual((await admin.login('ada@acme.com', 'nope-nope')).status, 401);
  assert.strictEqual((await admin.login('ADA@acme.com')).status, 200);

  const sam = client(base);
  assert.strictEqual((await admin.post('/api/team', { name: 'Sam', email: 'sam@acme.com', password: 'samspassword' })).status, 201);
  assert.strictEqual((await admin.post('/api/team', { name: 'Sam 2', email: 'sam@acme.com', password: 'samspassword' })).status, 409);
  assert.strictEqual((await sam.login('sam@acme.com', 'samspassword')).status, 200);
  assert.strictEqual((await sam.get('/api/team')).status, 403);
  assert.strictEqual((await sam.put('/api/settings', { company_name: 'Hacked' })).status, 403);

  // Changing your own password needs the current one.
  assert.strictEqual((await sam.post('/auth/password', { current: 'wrong-one', password: 'newpassword1' })).status, 400);
  assert.strictEqual((await sam.post('/auth/password', { current: 'samspassword', password: 'newpassword1' })).status, 200);
  assert.strictEqual((await client(base).login('sam@acme.com', 'newpassword1')).status, 200);

  // Turned off: signed out at once, and can't sign in.
  const samRow = (await admin.get('/api/team')).data.find((u) => u.email === 'sam@acme.com');
  assert.strictEqual((await admin.put(`/api/team/${samRow.id}`, { name: 'Sam', email: 'sam@acme.com', role: 'member', active: false })).status, 200);
  assert.strictEqual((await sam.get('/api/docs')).status, 401);
  assert.strictEqual((await client(base).login('sam@acme.com', 'newpassword1')).status, 401);
  // An admin can't lock themselves out, or touch another business's people.
  const adaRow = (await admin.get('/api/team')).data.find((u) => u.email === 'ada@acme.com');
  assert.strictEqual((await admin.put(`/api/team/${adaRow.id}`, { name: 'Ada', email: 'ada@acme.com', role: 'member' })).status, 400);
  const otherUser = addUser(db, addBusiness(db, 'Other Co'), 'x@other.com', 'X', 'admin');
  assert.strictEqual((await admin.put(`/api/team/${otherUser}`, { name: 'X', email: 'x@other.com', role: 'member', active: false })).status, 404);

  // Five wrong passwords lock the email for a while, even with the right one after.
  const x = client(base);
  for (let i = 0; i < 5; i++) await x.login('ada@acme.com', `wrong-${i}-pass`);
  assert.strictEqual((await x.login('ada@acme.com')).status, 429);
});

test('logo: uploaded on the Company tab, shown to customers and printed on the PDF', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => server.close());
  addUser(db, addBusiness(db), 'ada@acme.com', 'Ada', 'admin');
  const admin = client(base);
  await admin.login('ada@acme.com');
  assert.strictEqual((await admin.put('/api/settings/logo', { data: 'data:image/png;base64,AAAA' })).status, 400);
  assert.strictEqual((await admin.put('/api/settings/logo', { data: pngDataUrl() })).status, 200);
  assert.strictEqual((await admin.get('/api/meta')).data.logo, true);
  const logo = await admin.get('/api/logo');
  assert.strictEqual(logo.headers.get('content-type'), 'image/png');
  const id = (await admin.post('/api/docs', { type: 'invoice', lines: [{ name: 'Work', unit_price: '10' }] })).data.id;
  const pdf = await admin.get(`/api/docs/${id}/pdf`);
  assert.strictEqual(pdf.data.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.data.includes('/Subtype /Image'));
  await admin.del('/api/settings/logo');
  assert.strictEqual((await admin.get('/api/logo')).status, 404);
});
