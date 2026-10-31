const { startServer, client, addBusiness, addUser } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { services } = require('../server/mail');

async function setup(t) {
  const { db, server, base } = await startServer();
  t.after(() => {
    server.close();
    services.mail = null;
  });
  const b = addBusiness(db, 'Ortiz Plumbing & Sons');
  addUser(db, b, 'ada@ortiz.com', 'Ada', 'admin');
  addUser(db, b, 'sam@ortiz.com', 'Sam', 'member', 'es');
  const admin = client(base);
  await admin.login('ada@ortiz.com');
  const member = client(base);
  await member.login('sam@ortiz.com');
  return { db, b, base, admin, member, anon: client(base) };
}

const premium = (db, b) => db.prepare("UPDATE businesses SET plan = 'premium', subscription_status = 'active' WHERE id = ?").run(b);
const form = (fields) => new URLSearchParams(fields).toString();
const post = (c, slug, fields) => c.raw('POST', `/s/${slug}/contact`, form(fields), { 'Content-Type': 'application/x-www-form-urlencoded' });

test('website: set up in both languages, published with Premium only', async (t) => {
  const { db, b, admin, member, anon } = await setup(t);
  let site = (await admin.get('/api/site')).data;
  assert.strictEqual(site.slug, 'ortiz-plumbing-sons');
  assert.strictEqual(site.content.es.cta, 'Pida una cotización gratis');
  assert.strictEqual(site.premium, false);
  assert.strictEqual((await member.put('/api/site', { slug: 'x' })).status, 403);

  const content = {
    en: { headline: 'Licensed plumbing in San Bernardino', tagline: 'Fast, honest repairs.', services: 'Water heaters\nDrain cleaning\n\nLeak repair', about: 'Family owned since 2005.', cta: 'Get a free quote' },
    es: { headline: 'Plomería con licencia en San Bernardino', tagline: '', services: ['Calentadores de agua', 'Destape de drenajes'], about: '', cta: '' },
  };
  // Publishing needs Premium; saving doesn't.
  const denied = await admin.put('/api/site', { content, published: true }, { 'X-Lang': 'es' });
  assert.strictEqual(denied.status, 400);
  site = (await admin.put('/api/site', { content, slug: 'Ortiz Plumbing!', phone: '909-555-0100', color: '#0a7f5a' })).data;
  assert.strictEqual(site.slug, 'ortiz-plumbing');
  assert.deepStrictEqual(site.content.en.services, ['Water heaters', 'Drain cleaning', 'Leak repair']);
  assert.strictEqual((await anon.get('/s/ortiz-plumbing')).status, 404); // not published

  premium(db, b);
  site = (await admin.put('/api/site', { published: true })).data;
  assert.strictEqual(site.published, true);
  // Another business can't take the address.
  const other = addBusiness(db, 'Other');
  addUser(db, other, 'o@o.com', 'O', 'admin');
  const oc = client(t.base || site.url.split('/s/')[0]);
  await oc.login('o@o.com');
  assert.strictEqual((await oc.put('/api/site', { slug: 'ortiz-plumbing' })).status, 400);
  assert.strictEqual((await oc.put('/api/site', { slug: 'api' })).status, 400);

  // The page, in English and in Spanish (blank Spanish fields fall back to English).
  const en = (await anon.get('/s/ortiz-plumbing?lang=en')).data.toString();
  assert.match(en, /<html lang="en">/);
  assert.match(en, /Licensed plumbing in San Bernardino/);
  assert.match(en, /<li>Drain cleaning<\/li>/);
  assert.match(en, /Family owned since 2005\./);
  assert.match(en, /href="\?lang=es"/);
  assert.match(en, /--c: #0a7f5a/);
  const es = (await anon.get('/s/ortiz-plumbing?lang=es')).data.toString();
  assert.match(es, /<html lang="es">/);
  assert.match(es, /Plomería con licencia/);
  assert.match(es, /Calentadores de agua/);
  assert.match(es, /Fast, honest repairs\./); // blank tagline in Spanish: the English one
  assert.match(es, /Get a free quote/); // and the button text
  assert.match(es, /Enviar solicitud/); // the page's own words are translated
  // Without ?lang, a Spanish browser gets Spanish.
  assert.match((await anon.get('/s/ortiz-plumbing', { 'Accept-Language': 'es-MX,es;q=0.9' })).data.toString(), /<html lang="es">/);

  // When Premium ends, the page goes offline.
  db.prepare("UPDATE businesses SET plan = 'free' WHERE id = ?").run(b);
  assert.strictEqual((await anon.get('/s/ortiz-plumbing')).status, 404);
});

test('website: the contact form makes a lead, a notice for everyone and an email to the owner', async (t) => {
  const { db, b, admin, member, anon } = await setup(t);
  premium(db, b);
  await admin.put('/api/site', { published: true, content: { en: { headline: 'Ortiz', services: 'Water heaters' }, es: { headline: 'Ortiz' } } });
  const sent = [];
  services.mail = async (m) => sent.push(m);

  // Missing contact details: the form comes back with the error, in the visitor's language.
  const bad = await post(anon, 'ortiz-plumbing-sons', { lang: 'es', name: 'Luis' });
  assert.strictEqual(bad.status, 200);
  const badHtml = await bad.text();
  assert.match(badHtml, /Escriba un teléfono o correo electrónico para que podamos comunicarnos con usted\./);
  assert.match(badHtml, /value="Luis"/);
  // Bots fill in the hidden field: it looks sent, but nothing is saved.
  assert.strictEqual((await post(anon, 'ortiz-plumbing-sons', { name: 'Bot', email: 'b@b.com', company_website: 'spam.example' })).status, 303);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 0);

  const ok = await post(anon, 'ortiz-plumbing-sons', { lang: 'es', name: 'Luis Pérez', phone: '909-555-0199', service: 'Water heaters', address: '12 Elm St', message: 'Se rompió mi calentador.' });
  assert.strictEqual(ok.status, 303);
  assert.match(ok.headers.get('location'), /sent=1/);
  assert.match((await anon.get('/s/ortiz-plumbing-sons?lang=es&sent=1')).data.toString(), /Gracias/);

  const leads = (await member.get('/api/leads')).data;
  assert.strictEqual(leads.length, 1);
  assert.strictEqual(leads[0].language, 'es');
  assert.strictEqual(leads[0].status, 'new');
  // Everyone on the team gets the notice, each in their own language; the administrator also gets an email.
  assert.strictEqual((await admin.get('/api/notifications')).data.items[0].text, 'New lead: Luis Pérez (Water heaters)');
  assert.strictEqual((await member.get('/api/notifications')).data.items[0].text, 'Nuevo cliente potencial: Luis Pérez (Water heaters)');
  assert.deepStrictEqual(sent.map((m) => m.to[0]), ['ada@ortiz.com']);
  await admin.post('/api/notifications/read', {});
  assert.strictEqual((await admin.get('/api/notifications')).data.unread, 0);
  assert.strictEqual((await member.get('/api/notifications')).data.unread, 1);

  // Lead to quote: the lead becomes a Spanish-speaking customer, and the lead is marked quoted.
  const r = (await member.post(`/api/leads/${leads[0].id}/quote`)).data;
  const contact = (await admin.get('/api/contacts')).data.find((c) => c.id === r.contact_id);
  assert.strictEqual(contact.language, 'es');
  assert.strictEqual(contact.phone, '909-555-0199');
  assert.strictEqual(r.job_address, '12 Elm St');
  assert.strictEqual((await admin.get('/api/leads')).data[0].status, 'quoted');
  assert.strictEqual((await admin.put(`/api/leads/${leads[0].id}`, { status: 'won' })).status, 200);
  assert.strictEqual((await admin.put(`/api/leads/${leads[0].id}`, { status: 'maybe' })).status, 400);

  // A quote for them gets Spanish terms by default.
  const q = (await admin.post('/api/docs', { type: 'quote', contact_id: r.contact_id, lines: [{ name: 'Calentador', unit_price: '1850' }] })).data.id;
  assert.match((await admin.get(`/api/docs/${q}`)).data.doc.terms, /^Los precios/);

  // A few requests per visitor per hour.
  for (let i = 0; i < 4; i++) await post(anon, 'ortiz-plumbing-sons', { name: `P${i}`, email: `p${i}@x.com` });
  const limited = await post(anon, 'ortiz-plumbing-sons', { name: 'P5', email: 'p5@x.com' });
  assert.strictEqual(limited.status, 200);
  assert.match(await limited.text(), /Too many requests/);
});
