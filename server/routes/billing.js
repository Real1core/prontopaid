// Quotes and invoices (see server/billing.js). Everyone signed in can make them and sees their
// own; admins see everyone's and set the company details. Customers and the price list are shared.
// The public router serves the link a customer gets: view, approve or decline, download the PDF.
const fs = require('fs');
const express = require('express');
const { requireUser } = require('../auth');
const { HttpError, parseEmails, isEmail, escapeHtml, baseUrl } = require('../util');
const billing = require('../billing');
const logo = require('../logo');
const { generateDocument } = require('../billing-pdf');

// Replaced in tests; otherwise SMTP email when it's set up.
const services = { mail: null };
const mailer = () => services.mail || require('../mail').mailer();

async function pdfFor(db, id, base) {
  const detail = billing.documentDetail(db, id);
  const data = await generateDocument(detail, billing.getSettings(db), billing.publicUrl(base, detail.doc));
  return { detail, data, filename: billing.pdfFilename(detail) };
}

function sendPdf(res, { data, filename }, download) {
  res.type('application/pdf');
  res.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename.replace(/"/g, '')}"`);
  res.send(data);
}

function billingRouter(db) {
  const router = express.Router();
  router.use(requireUser);
  const adminOnly = (req) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can do that.');
  };
  const docId = (req) => billing.documentForUser(db, Number(req.params.id), req.user).id;

  router.get('/meta', (_req, res) => {
    res.json({
      settings: billing.getSettings(db),
      kinds: billing.CONTACT_KINDS,
      units: billing.UNITS,
      methods: billing.PAYMENT_METHODS,
      mail: Boolean(mailer()),
      logo: Boolean(logo.current()),
    });
  });

  router.put('/settings', (req, res) => {
    adminOnly(req);
    res.json(billing.saveSettings(db, req.body));
  });

  // Body: {data: "data:image/png;base64,…"}
  router.put('/settings/logo', (req, res) => {
    adminOnly(req);
    logo.save(req.body.data);
    res.json({ ok: true });
  });

  router.delete('/settings/logo', (req, res) => {
    adminOnly(req);
    logo.remove();
    res.json({ ok: true });
  });

  // ---- Customers ------------------------------------------------------------------------
  router.get('/contacts', (req, res) => res.json(billing.listContacts(db, { archived: req.query.archived === '1' })));
  router.post('/contacts', (req, res) => res.status(201).json({ id: billing.saveContact(db, null, req.body) }));
  router.put('/contacts/:id', (req, res) => res.json({ id: billing.saveContact(db, Number(req.params.id), req.body) }));
  router.delete('/contacts/:id', (req, res) => {
    adminOnly(req);
    const id = Number(req.params.id);
    if (db.prepare('SELECT 1 FROM documents WHERE contact_id = ?').get(id)) {
      throw new HttpError(409, 'This customer has quotes or invoices. Archive them instead, so those keep their name.');
    }
    db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // ---- Price list -----------------------------------------------------------------------
  router.get('/items', (_req, res) => res.json(billing.listItems(db)));
  router.post('/items', (req, res) => res.status(201).json({ id: billing.saveItem(db, null, req.body) }));
  router.put('/items/:id', (req, res) => res.json({ id: billing.saveItem(db, Number(req.params.id), req.body) }));
  router.delete('/items/:id', (req, res) => {
    db.prepare('DELETE FROM catalog_items WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---- Quotes and invoices --------------------------------------------------------------
  router.get('/docs', (req, res) => {
    const userId = req.user.role === 'admin' ? null : req.user.id;
    const quotes = billing.listDocuments(db, { type: 'quote', userId });
    const invoices = billing.listDocuments(db, { type: 'invoice', userId });
    res.json({ quotes, invoices, summary: billing.summary(quotes, invoices) });
  });

  router.post('/docs', (req, res) => {
    res.status(201).json({ id: billing.createDocument(db, req.body.type, req.body, req.user) });
  });

  router.get('/docs/:id', (req, res) => {
    const detail = billing.documentDetail(db, docId(req));
    res.json({ ...detail, public_url: billing.publicUrl(baseUrl(req), detail.doc) });
  });

  router.put('/docs/:id', (req, res) => {
    billing.updateDocument(db, docId(req), req.body);
    res.json({ ok: true });
  });

  router.delete('/docs/:id', (req, res) => {
    db.prepare('DELETE FROM documents WHERE id = ?').run(docId(req));
    res.json({ ok: true });
  });

  router.post('/docs/:id/duplicate', (req, res) => {
    res.status(201).json({ id: billing.duplicateDocument(db, docId(req), req.user) });
  });

  router.post('/docs/:id/convert', (req, res) => {
    res.status(201).json(billing.convertToInvoice(db, docId(req), req.user));
  });

  // Body: {status, name}; name is who approved, or why it was declined.
  router.post('/docs/:id/status', (req, res) => {
    const id = docId(req);
    billing.setStatus(db, id, req.body, req.user);
    res.json({ ok: true });
  });

  // Sent some other way (text message, printed, link copied): just record it.
  router.post('/docs/:id/mark-sent', (req, res) => {
    billing.markSent(db, docId(req), req.body.to ? String(req.body.to).slice(0, 500) : null);
    res.json({ ok: true });
  });

  // Body: {to, cc, message}. Emails the PDF with a link to view (and approve) it online.
  router.post('/docs/:id/send', async (req, res) => {
    const id = docId(req);
    const send = mailer();
    if (!send) throw new HttpError(409, "Email isn't set up in this app yet. Download the PDF or copy the link and send it yourself.");
    const to = parseEmails(req.body.to);
    const cc = parseEmails(req.body.cc);
    if (!to.length) throw new HttpError(400, 'Enter an email address to send it to.');
    const bad = [...to, ...cc].filter((e) => !isEmail(e));
    if (bad.length) throw new HttpError(400, `Not a valid email address: ${bad.join(', ')}`);
    const pdf = await pdfFor(db, id, baseUrl(req));
    const { doc, totals } = pdf.detail;
    const settings = billing.getSettings(db);
    const label = billing.TYPE_LABEL[doc.type];
    const link = billing.publicUrl(baseUrl(req), doc);
    const amount = doc.type === 'invoice' ? `Amount due: <strong>${billing.fmtMoney(totals.balance)}</strong>${doc.due_date ? ` by ${escapeHtml(doc.due_date)}` : ''}` : `Total: <strong>${billing.fmtMoney(totals.total)}</strong>`;
    const message = String(req.body.message ?? '').trim();
    const html = `${message ? `<p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>` : ''}
<p>${label} ${escapeHtml(doc.number)}${doc.title ? ` — ${escapeHtml(doc.title)}` : ''}<br>${amount}</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#1d4e89;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">${doc.type === 'quote' ? 'View and approve the quote' : 'View the invoice'}</a></p>
<p>The ${label.toLowerCase()} is also attached as a PDF.</p>
<p>${escapeHtml(settings.company_name || req.user.name)}${settings.company_phone ? `<br>${escapeHtml(settings.company_phone)}` : ''}${settings.company_email ? `<br>${escapeHtml(settings.company_email)}` : ''}</p>`;
    try {
      await send({
        to,
        cc,
        replyTo: req.user.email,
        fromName: settings.company_name || undefined,
        subject: `${label} ${doc.number}${settings.company_name ? ` from ${settings.company_name}` : ''}${doc.title ? `: ${doc.title}` : ''}`,
        html,
        attachments: [{ name: pdf.filename, contentType: 'application/pdf', content: pdf.data }],
      });
    } catch (err) {
      console.error(err);
      throw new HttpError(502, `The email couldn't be sent: ${err.message}`);
    }
    billing.markSent(db, id, to.join(', '));
    res.json({ ok: true });
  });

  router.post('/docs/:id/payments', (req, res) => {
    billing.addPayment(db, docId(req), req.body, req.user);
    res.status(201).json({ ok: true });
  });

  router.delete('/docs/:id/payments/:paymentId', (req, res) => {
    db.prepare('DELETE FROM payments WHERE id = ? AND document_id = ?').run(Number(req.params.paymentId), docId(req));
    res.json({ ok: true });
  });

  router.get('/docs/:id/pdf', async (req, res) => {
    sendPdf(res, await pdfFor(db, docId(req), baseUrl(req)), req.query.download === '1');
  });

  return router;
}

// ---- The customer's link (no sign-in) ---------------------------------------------------------

function publicRouter(db) {
  const router = express.Router();

  // Drafts aren't shown: the link only works once it's been sent.
  const byToken = (token) => {
    const doc = db.prepare("SELECT id FROM documents WHERE public_token = ? AND status != 'draft'").get(String(token));
    if (!doc) throw new HttpError(404, "This link isn't valid any more. Ask the sender for a new one.");
    return billing.documentDetail(db, doc.id);
  };

  router.get('/docs/:token', (req, res) => {
    const detail = byToken(req.params.token);
    const { doc, lines, payments, contact, totals } = detail;
    if (!doc.viewed_at) db.prepare("UPDATE documents SET viewed_at = datetime('now') WHERE id = ?").run(doc.id);
    const s = billing.getSettings(db);
    res.json({
      company: { logo: Boolean(logo.current()), name: s.company_name, address: s.company_address, phone: s.company_phone, email: s.company_email, website: s.company_website, license_number: s.license_number, payment_instructions: s.payment_instructions },
      doc: {
        type: doc.type, number: doc.number, title: doc.title, job_address: doc.job_address, issue_date: doc.issue_date, due_date: doc.due_date,
        discount_type: doc.discount_type, discount_value: doc.discount_value, tax_rate: doc.tax_rate, deposit_percent: doc.deposit_percent,
        notes: doc.notes, terms: doc.terms, display_status: doc.display_status, status_label: doc.status_label,
        approved_at: doc.approved_at, approved_name: doc.approved_name, declined_at: doc.declined_at,
        can_respond: doc.type === 'quote' && ['sent', 'viewed', 'expired'].includes(doc.display_status),
      },
      contact: contact ? { name: contact.name, company: contact.company } : null,
      lines: lines.map(({ name, description, quantity, unit, unit_price, taxable }) => ({ name, description, quantity, unit, unit_price, taxable })),
      payments: payments.map(({ amount, paid_on, method }) => ({ amount, paid_on, method })),
      totals,
    });
  });

  // The logo, for the customer's page.
  router.get('/logo', (_req, res) => {
    const file = logo.current();
    if (!file) throw new HttpError(404, 'No logo.');
    res.type(file.mime).set('Cache-Control', 'no-cache').send(fs.readFileSync(file.path));
  });

  // Tell whoever made the quote. Best effort: the customer's answer is saved either way.
  const notify = async (req, detail, subject, text) => {
    const send = mailer();
    const maker = detail.doc.created_by ? db.prepare('SELECT email FROM users WHERE id = ? AND active = 1').get(detail.doc.created_by) : null;
    if (!send || !maker) return;
    try {
      await send({ to: [maker.email], subject, html: `<p>${escapeHtml(text)}</p><p><a href="${escapeHtml(baseUrl(req))}/#/doc/${detail.doc.id}">Open it in the app</a></p>` });
    } catch (err) {
      console.error(err);
    }
  };

  const respond = (req) => {
    const detail = byToken(req.params.token);
    if (detail.doc.type !== 'quote') throw new HttpError(400, 'Only quotes can be approved.');
    if (!['sent', 'viewed', 'expired'].includes(detail.doc.display_status)) throw new HttpError(409, `This quote is already ${detail.doc.status_label.toLowerCase()}.`);
    return detail;
  };

  router.post('/docs/:token/approve', async (req, res) => {
    const detail = respond(req);
    const name = String(req.body.name ?? '').trim().slice(0, 200);
    if (!name) throw new HttpError(400, 'Type your full name to approve.');
    db.prepare("UPDATE documents SET status = 'approved', approved_at = datetime('now'), approved_name = ?, updated_at = datetime('now') WHERE id = ?").run(name, detail.doc.id);
    const who = detail.contact ? ` (${detail.contact.name})` : '';
    await notify(req, detail, `Quote ${detail.doc.number} approved`, `${name}${who} approved quote ${detail.doc.number}${detail.doc.title ? ` — ${detail.doc.title}` : ''} for ${billing.fmtMoney(detail.totals.total)}.`);
    res.json({ ok: true });
  });

  router.post('/docs/:token/decline', async (req, res) => {
    const detail = respond(req);
    const reason = String(req.body.reason ?? '').trim().slice(0, 2000);
    db.prepare("UPDATE documents SET status = 'declined', declined_at = datetime('now'), decline_reason = ?, updated_at = datetime('now') WHERE id = ?").run(reason || null, detail.doc.id);
    await notify(req, detail, `Quote ${detail.doc.number} declined`, `Quote ${detail.doc.number}${detail.doc.title ? ` — ${detail.doc.title}` : ''} was declined${reason ? `: "${reason}"` : '.'}`);
    res.json({ ok: true });
  });

  router.get('/docs/:token/pdf', async (req, res) => {
    sendPdf(res, await pdfFor(db, byToken(req.params.token).doc.id, baseUrl(req)), req.query.download === '1');
  });

  return router;
}

module.exports = { billingRouter, publicRouter, services };
