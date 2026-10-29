const { startServer, client, addUser } = require('./helpers');
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

test('auth: first run sets up the business and its administrator, once', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);
  assert.deepStrictEqual((await c.get('/auth/me')).data, { user: null, needsSetup: true });
  assert.strictEqual((await c.get('/api/docs')).status, 401);
  assert.strictEqual((await c.post('/auth/setup', { company_name: 'Acme', name: 'Ada', email: 'ada@acme.com', password: 'short' })).status, 400);
  assert.strictEqual((await c.post('/auth/setup', { company_name: 'Acme', name: 'Ada', email: 'ada@acme.com', password: 'longenough' })).status, 201);
  const me = (await c.get('/auth/me')).data;
  assert.strictEqual(me.user.role, 'admin');
  assert.strictEqual(me.needsSetup, false);
  const meta = (await c.get('/api/meta')).data;
  assert.strictEqual(meta.settings.company_name, 'Acme');
  assert.strictEqual(meta.settings.company_email, 'ada@acme.com');
  // Nobody else can "set up" the app again.
  assert.strictEqual((await client(base).post('/auth/setup', { company_name: 'X', name: 'X', email: 'x@x.com', password: 'longenough' })).status, 409);
});

test('auth: sign in, wrong passwords, team members and turning an account off', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => server.close());
  addUser(db, 'ada@acme.com', 'Ada', 'admin');
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
  // An admin can't lock themselves out.
  const adaRow = (await admin.get('/api/team')).data.find((u) => u.email === 'ada@acme.com');
  assert.strictEqual((await admin.put(`/api/team/${adaRow.id}`, { name: 'Ada', email: 'ada@acme.com', role: 'member' })).status, 400);

  // Five wrong passwords lock the email for a while, even with the right one after.
  const x = client(base);
  for (let i = 0; i < 5; i++) await x.login('ada@acme.com', `wrong-${i}-pass`);
  assert.strictEqual((await x.login('ada@acme.com')).status, 429);
});

test('logo: uploaded on the Company tab, shown to customers and printed on the PDF', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => server.close());
  addUser(db, 'ada@acme.com', 'Ada', 'admin');
  const admin = client(base);
  await admin.login('ada@acme.com');
  assert.strictEqual((await admin.put('/api/settings/logo', { data: 'data:image/png;base64,AAAA' })).status, 400);
  assert.strictEqual((await admin.put('/api/settings/logo', { data: pngDataUrl() })).status, 200);
  assert.strictEqual((await admin.get('/api/meta')).data.logo, true);
  const logo = await client(base).get('/api/public/logo');
  assert.strictEqual(logo.headers.get('content-type'), 'image/png');
  const id = (await admin.post('/api/docs', { type: 'invoice', lines: [{ name: 'Work', unit_price: '10' }] })).data.id;
  const pdf = await admin.get(`/api/docs/${id}/pdf`);
  assert.strictEqual(pdf.data.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.data.includes('/Subtype /Image'));
  await admin.del('/api/settings/logo');
  assert.strictEqual((await client(base).get('/api/public/logo')).status, 404);
});
