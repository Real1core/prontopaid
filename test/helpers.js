const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated data folder, and no email, for every test run (set before config loads).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'prontopaid-test-'));
for (const key of ['SMTP_HOST', 'MAIL_FROM', 'BASE_URL', 'SESSION_SECRET', 'PREMIUM_FOR_ALL', 'WISETACK_API_KEY']) delete process.env[key];
// Stripe and the lender are faked in the tests (stripe.transport, financing.transport).
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.STRIPE_PREMIUM_PRICE_ID = 'price_premium';
process.env.FINANCING_PROVIDER = 'test';

const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { hashPassword } = require('../server/auth');

async function startServer() {
  const db = openDb(':memory:');
  const server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base };
}

/** Minimal cookie-keeping client. */
function client(base) {
  let cookie = '';
  async function request(method, url, body, extra = {}) {
    const headers = { cookie, ...extra };
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie();
    if (set.length) {
      const jar = Object.fromEntries(cookie.split('; ').filter(Boolean).map((c) => c.split(/=(.*)/s).slice(0, 2)));
      for (const c of set) {
        const [pair] = c.split(';');
        const [k, v] = pair.split(/=(.*)/s);
        jar[k] = v;
      }
      cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (u, headers) => request('GET', u, undefined, headers),
    post: (u, b, headers) => request('POST', u, b, headers),
    put: (u, b, headers) => request('PUT', u, b, headers),
    del: (u) => request('DELETE', u),
    raw: (method, u, body, headers) => fetch(base + u, { method, headers: { cookie, ...headers }, body, redirect: 'manual' }),
    login: (email, password = 'password123') => request('POST', '/auth/login', { email, password }),
  };
}

/** A business, named as given. */
function addBusiness(db, name = 'Acme Repairs') {
  const id = Number(db.prepare('INSERT INTO businesses (name) VALUES (?)').run(name).lastInsertRowid);
  db.prepare("INSERT INTO settings (business_id, key, value) VALUES (?, 'company_name', ?)").run(id, JSON.stringify(name));
  return id;
}

/** Add a person to a business with the password "password123". */
function addUser(db, businessId, email, name, role = 'member', language = 'en') {
  return Number(db.prepare('INSERT INTO users (business_id, email, name, role, password_hash, language) VALUES (?, ?, ?, ?, ?, ?)').run(businessId, email, name, role, hashPassword('password123'), language).lastInsertRowid);
}

/** A fake fetch that answers from a list of [method, url-regex, response or (url, opts) => response], and records calls. */
function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body, headers: opts.headers });
    const hit = handlers.find(([m, re]) => m === (opts.method || 'GET') && re.test(url));
    if (!hit) return { ok: false, status: 404, json: async () => ({ error: { message: `no fake for ${opts.method} ${url}` } }) };
    const out = typeof hit[2] === 'function' ? hit[2](url, opts) : hit[2];
    return { ok: true, status: 200, json: async () => out };
  };
  fn.calls = calls;
  return fn;
}

module.exports = { startServer, client, addBusiness, addUser, fakeFetch };
