const config = require('./config');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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

module.exports = { HttpError, isoDate, sanitizeName, parseEmails, isEmail, escapeHtml, baseUrl };
