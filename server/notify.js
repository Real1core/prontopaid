// The bell in the app: new leads, quotes approved or declined, payments and financing updates.
// Each person on the business's team gets the notice in their own language, and the
// administrators also get an email when email is set up.
const { mailer } = require('./mail');
const { tr } = require('../public/i18n');
const { escapeHtml } = require('./util');

/**
 * @param {object} n
 * @param {string} n.kind    lead, approved, declined, paid, financing
 * @param {string} n.text    English text with {placeholders}, e.g. 'New lead: {name}'
 * @param {object} [n.params]
 * @param {string} [n.link]  where tapping it goes, e.g. '#/doc/12'
 * @param {string} [n.base]  the app's address, for the link in the email
 * @param {object} [n.only]  {userId}: only this person (e.g. whoever made the quote)
 */
async function notify(db, businessId, { kind, text, params = {}, link = '', base = '', only = null }) {
  const users = db.prepare('SELECT id, email, name, role, language FROM users WHERE business_id = ? AND active = 1').all(businessId)
    .filter((u) => !only || u.id === only.userId || u.role === 'admin');
  const insert = db.prepare('INSERT INTO notifications (business_id, user_id, kind, text, params, link) VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => users.forEach((u) => insert.run(businessId, u.id, kind, text, JSON.stringify(params), link)))();
  const send = mailer();
  if (!send) return;
  // Email the administrators, and whoever the notice is for.
  for (const u of users.filter((x) => x.role === 'admin' || (only && x.id === only.userId))) {
    const body = tr(u.language, text, params);
    try {
      await send({
        to: [u.email],
        subject: `ProntoPaid: ${body}`,
        html: `<p>${escapeHtml(body)}</p>${base && link ? `<p><a href="${escapeHtml(base + '/' + link)}">${escapeHtml(tr(u.language, 'Open it in ProntoPaid'))}</a></p>` : ''}`,
      });
    } catch (err) {
      console.error(err); // the notice is in the app either way
    }
  }
}

/** A person's latest notices, in their language, and how many are unread. */
function listFor(db, user, limit = 30) {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(user.id, limit);
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(user.id).n;
  return {
    unread,
    items: rows.map((r) => ({ id: r.id, kind: r.kind, text: tr(user.language, r.text, JSON.parse(r.params)), link: r.link, read: Boolean(r.read_at), created_at: r.created_at })),
  };
}

module.exports = { notify, listFor };
