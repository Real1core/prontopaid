const config = require('./config');
const { tr, pick } = require('../public/i18n');

/** A message for people, translated when it's shown: msg('Line {n} needs a name.', {n: 2}). */
const msg = (text, params) => ({ text, params });

/**
 * An error whose message is shown to the person, in their language.
 * `message` is English text (with {placeholders} filled from params) or a list of msg()s.
 */
class HttpError extends Error {
  constructor(status, message, params) {
    const parts = Array.isArray(message) ? message : [msg(message, params)];
    super(parts.map((p) => tr('en', p.text, p.params)).join(' '));
    this.status = status;
    this.parts = parts;
  }

  translated(lang) {
    return this.parts.map((p) => tr(lang, p.text, p.params)).join(' ');
  }
}

/** 'es' or 'en' from the browser's preferred language (Accept-Language), or null if it's neither. */
function browserLang(req) {
  const first = String(req.get('accept-language') || '').split(',')[0].trim().toLowerCase();
  return first.startsWith('es') ? 'es' : first.startsWith('en') ? 'en' : null;
}

/** The language of a request: the one the page asked for, the signed-in person's, or the browser's. */
function requestLang(req) {
  return pick(req.get('x-lang') || (req.user && req.user.language) || browserLang(req) || 'en');
}

/** YYYY-MM-DD in the app's time zone. */
function isoDate(date = new Date(), timeZone = config.timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Remove characters not allowed in file names. */
function sanitizeName(name) {
  return String(name)
    .replace(/["*:<>?/\\|#%]/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

function parseEmails(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Where the app is reached, for links in emails: BASE_URL, or the address of this request. */
const baseUrl = (req) => config.baseUrl || `${req.protocol}://${req.get('host')}`;

module.exports = { HttpError, msg, browserLang, requestLang, isoDate, sanitizeName, parseEmails, isEmail, escapeHtml, baseUrl };
