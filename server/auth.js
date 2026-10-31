// Sign-up and sign-in with email and password. Anyone can sign up a business and becomes its
// administrator; administrators add the rest of their team on the Team tab. Everything a person
// sees belongs to their own business (req.business).
const crypto = require('crypto');
const express = require('express');
const { HttpError, msg, isEmail } = require('./util');
const { pick } = require('../public/i18n');

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

const passwordProblem = (password) => (String(password || '').length < MIN_PASSWORD ? msg('Use a password of at least {n} characters.', { n: MIN_PASSWORD }) : null);

// After 5 wrong passwords for an email, wait 15 minutes.
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;

function loadUser(db) {
  return (req, _res, next) => {
    req.user = null;
    req.business = null;
    if (req.session && req.session.userId) {
      req.user = db.prepare('SELECT id, business_id, email, name, role, language FROM users WHERE id = ? AND active = 1').get(req.session.userId) || null;
      if (req.user) req.business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.user.business_id);
      else req.session = null;
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
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Only administrators can do that.'));
  next();
}

function userInput(body, { password = true } = {}) {
  const name = String(body.name ?? '').trim().slice(0, 100);
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 200);
  const errors = [];
  if (!name) errors.push(msg('Enter a name.'));
  if (!isEmail(email)) errors.push(msg('Enter a valid email address.'));
  if (password) {
    const problem = passwordProblem(body.password);
    if (problem) errors.push(problem);
  }
  if (errors.length) throw new HttpError(400, errors);
  return { name, email, role: body.role === 'admin' ? 'admin' : 'member', language: pick(body.language) };
}

/**
 * @param {object} hooks
 * @param {(db, businessId, values) => void} hooks.onSignup  saves the business's first settings
 */
function authRouter(db, { onSignup } = {}) {
  const router = express.Router();
  const failures = new Map(); // email -> {count, until}, for the lock above

  router.get('/me', (req, res) => {
    res.json({ user: req.user, business: req.business ? { id: req.business.id, name: req.business.name } : null });
  });

  // A new business and its first administrator.
  router.post('/signup', (req, res) => {
    const company = String(req.body.company_name ?? '').trim().slice(0, 200);
    const u = userInput(req.body);
    if (!company) throw new HttpError(400, 'Enter your business name.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(u.email)) throw new HttpError(409, 'That email already has an account. Sign in instead.');
    const userId = db.transaction(() => {
      const businessId = Number(db.prepare('INSERT INTO businesses (name) VALUES (?)').run(company).lastInsertRowid);
      if (onSignup) onSignup(db, businessId, { company_name: company, company_email: u.email });
      return Number(db.prepare("INSERT INTO users (business_id, email, name, role, password_hash, language, last_sign_in_at) VALUES (?, ?, ?, 'admin', ?, ?, datetime('now'))")
        .run(businessId, u.email, u.name, hashPassword(req.body.password), u.language).lastInsertRowid);
    })();
    req.session.userId = userId;
    res.status(201).json({ ok: true });
  });

  router.post('/login', (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const f = failures.get(email);
    if (f && f.count >= LOCK_AFTER && Date.now() < f.until) throw new HttpError(429, 'Too many wrong passwords. Try again in 15 minutes.');
    const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ? AND active = 1').get(email);
    if (!user || !checkPassword(req.body.password ?? '', user.password_hash)) {
      failures.set(email, { count: (f && Date.now() < f.until ? f.count : 0) + 1, until: Date.now() + LOCK_MS });
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
    if (problem) throw new HttpError(400, [problem]);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), req.user.id);
    res.json({ ok: true });
  });

  // The English / Español switch in the menu.
  router.put('/language', requireUser, (req, res) => {
    db.prepare('UPDATE users SET language = ? WHERE id = ?').run(pick(req.body.language), req.user.id);
    res.json({ ok: true });
  });

  return router;
}

/** The Team tab: administrators add people, change their role, reset passwords and turn accounts off. */
function teamRouter(db) {
  const router = express.Router();
  router.use(requireAdmin);
  const member = (req) => {
    const row = db.prepare('SELECT * FROM users WHERE id = ? AND business_id = ?').get(Number(req.params.id), req.user.business_id);
    if (!row) throw new HttpError(404, 'Not found.');
    return row;
  };

  router.get('/', (req, res) => {
    res.json(db.prepare('SELECT id, email, name, role, language, active, last_sign_in_at, created_at FROM users WHERE business_id = ? ORDER BY active DESC, name COLLATE NOCASE').all(req.user.business_id));
  });

  router.post('/', (req, res) => {
    const u = userInput(req.body);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(u.email)) throw new HttpError(409, 'That email already has an account.');
    const id = db.prepare('INSERT INTO users (business_id, email, name, role, password_hash, language) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.business_id, u.email, u.name, u.role, hashPassword(req.body.password), u.language).lastInsertRowid;
    res.status(201).json({ id: Number(id) });
  });

  // Body: {name, email, role, active, password?}. A password here resets theirs.
  router.put('/:id', (req, res) => {
    const current = member(req);
    const u = userInput(req.body, { password: Boolean(req.body.password) });
    const active = req.body.active === undefined ? current.active : req.body.active ? 1 : 0;
    if (current.id === req.user.id && (u.role !== 'admin' || !active)) throw new HttpError(400, "You can't remove your own administrator access.");
    if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(u.email, current.id)) throw new HttpError(409, 'That email already has an account.');
    db.prepare('UPDATE users SET name = ?, email = ?, role = ?, active = ? WHERE id = ?').run(u.name, u.email, u.role, active, current.id);
    if (req.body.password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), current.id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { authRouter, teamRouter, loadUser, requireUser, requireAdmin, hashPassword, checkPassword };
