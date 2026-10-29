// Sign-in with email and password. The first person to open the app sets up the business and
// becomes its administrator; administrators add the rest of the team on the Team page.
const crypto = require('crypto');
const express = require('express');
const { HttpError, isEmail } = require('./util');

const MIN_PASSWORD = 8;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function checkPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function passwordProblem(password) {
  return String(password || '').length < MIN_PASSWORD ? `Use a password of at least ${MIN_PASSWORD} characters.` : null;
}

// After 5 wrong passwords for an email, wait 15 minutes.
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;

function loadUser(db) {
  return (req, _res, next) => {
    req.user = null;
    if (req.session && req.session.userId) {
      req.user = db.prepare('SELECT id, email, name, role FROM users WHERE id = ? AND active = 1').get(req.session.userId) || null;
      if (!req.user) req.session = null;
    }
    next();
  };
}

function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in.'));
  next();
}

function requireAdmin(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in.'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Administrators only.'));
  next();
}

function userInput(body, { password = true } = {}) {
  const name = String(body.name ?? '').trim().slice(0, 100);
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 200);
  const errors = [];
  if (!name) errors.push('Enter a name.');
  if (!isEmail(email)) errors.push('Enter a valid email address.');
  if (password) {
    const problem = passwordProblem(body.password);
    if (problem) errors.push(problem);
  }
  if (errors.length) throw new HttpError(400, errors.join(' '));
  return { name, email, role: body.role === 'admin' ? 'admin' : 'member' };
}

function authRouter(db, { onSetup } = {}) {
  const router = express.Router();
  const failures = new Map(); // email -> {count, until}, for the lock above
  const needsSetup = () => !db.prepare('SELECT 1 FROM users').get();

  router.get('/me', (req, res) => {
    res.json({ user: req.user, needsSetup: needsSetup() });
  });

  // First run: the business name and its first administrator.
  router.post('/setup', (req, res) => {
    if (!needsSetup()) throw new HttpError(409, 'This app is already set up. Sign in instead.');
    const company = String(req.body.company_name ?? '').trim().slice(0, 200);
    if (!company) throw new HttpError(400, 'Enter your business name.');
    const u = userInput(req.body);
    const id = Number(db.prepare("INSERT INTO users (email, name, role, password_hash, last_sign_in_at) VALUES (?, ?, 'admin', ?, datetime('now'))").run(u.email, u.name, hashPassword(req.body.password)).lastInsertRowid);
    if (onSetup) onSetup({ company_name: company, company_email: u.email });
    req.session.userId = id;
    res.status(201).json({ ok: true });
  });

  router.post('/login', (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const f = failures.get(email);
    if (f && f.count >= LOCK_AFTER && Date.now() < f.until) throw new HttpError(429, 'Too many wrong passwords. Try again in 15 minutes.');
    const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ? AND active = 1').get(email);
    if (!user || !checkPassword(req.body.password ?? '', user.password_hash)) {
      const next = { count: (f && Date.now() < f.until ? f.count : 0) + 1, until: Date.now() + LOCK_MS };
      failures.set(email, next);
      throw new HttpError(401, 'Wrong email or password.');
    }
    failures.delete(email);
    db.prepare("UPDATE users SET last_sign_in_at = datetime('now') WHERE id = ?").run(user.id);
    req.session.userId = user.id;
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    req.session = null;
    res.json({ ok: true });
  });

  router.post('/password', requireUser, (req, res) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!checkPassword(req.body.current ?? '', row.password_hash)) throw new HttpError(400, 'Your current password is wrong.');
    const problem = passwordProblem(req.body.password);
    if (problem) throw new HttpError(400, problem);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), req.user.id);
    res.json({ ok: true });
  });

  return router;
}

/** The Team page: administrators add people, change their role, reset passwords and turn accounts off. */
function teamRouter(db) {
  const router = express.Router();
  router.use(requireAdmin);

  router.get('/', (_req, res) => {
    res.json(db.prepare('SELECT id, email, name, role, active, last_sign_in_at, created_at FROM users ORDER BY active DESC, name COLLATE NOCASE').all());
  });

  router.post('/', (req, res) => {
    const u = userInput(req.body);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(u.email)) throw new HttpError(409, 'Someone with that email is already on the team.');
    const id = db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)').run(u.email, u.name, u.role, hashPassword(req.body.password)).lastInsertRowid;
    res.status(201).json({ id: Number(id) });
  });

  // Body: {name, email, role, active, password?}. A password here resets theirs.
  router.put('/:id', (req, res) => {
    const id = Number(req.params.id);
    const current = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!current) throw new HttpError(404, 'Not found.');
    const u = userInput(req.body, { password: Boolean(req.body.password) });
    const active = req.body.active === undefined ? current.active : req.body.active ? 1 : 0;
    if (id === req.user.id && (u.role !== 'admin' || !active)) throw new HttpError(400, "You can't remove your own administrator access.");
    if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(u.email, id)) throw new HttpError(409, 'Someone else already uses that email.');
    db.prepare('UPDATE users SET name = ?, email = ?, role = ?, active = ? WHERE id = ?').run(u.name, u.email, u.role, active, id);
    if (req.body.password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { authRouter, teamRouter, loadUser, requireUser, requireAdmin, hashPassword, checkPassword };
