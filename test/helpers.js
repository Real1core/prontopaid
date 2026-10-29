const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated data folder, and no email, for every test run (set before config loads).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quotes-test-'));
for (const key of ['SMTP_HOST', 'MAIL_FROM', 'BASE_URL', 'SESSION_SECRET']) delete process.env[key];

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
  async function request(method, url, body) {
    const headers = { cookie };
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
    get: (u) => request('GET', u),
    post: (u, b) => request('POST', u, b),
    put: (u, b) => request('PUT', u, b),
    del: (u) => request('DELETE', u),
    login: (email, password = 'password123') => request('POST', '/auth/login', { email, password }),
  };
}

/** Add a team member with the password "password123". */
function addUser(db, email, name, role = 'member') {
  return Number(db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)').run(email, name, role, hashPassword('password123')).lastInsertRowid);
}

module.exports = { startServer, client, addUser };
