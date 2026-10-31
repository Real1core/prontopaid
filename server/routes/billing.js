// The business's quotes, invoices, customers, price list and company details. Everyone signed in
// can make quotes and invoices and sees their own; admins see their whole business's and set the
// company details. Customers and the price list are shared within the business.
const fs = require('fs');
const express = require('express');
const config = require('../config');
const { requireUser } = require('../auth');
const { HttpError, parseEmails, isEmail, escapeHtml, baseUrl } = require('../util');
const { tr } = require('../../public/i18n');
const billing = require('../billing');
const logo = require('../logo');
const financing = require('../financing');
const sites = require('../sites');
const payments = require('../payments');
const { mailer } = require('../mail');
const { generateDocument } = require('../billing-pdf');

/** The PDF of a quote or invoice, in the customer's language unless another is asked for. */
async function pdfFor(db, business, id, base, lang) {
  const detail = billing.documentDetail(db, id);
  const language = lang || detail.doc.language;
  const data = await generateDocument(detail, billing.getSettings(db, business.id), {
    businessId: business.id,
    lang: language,
    link: billing.publicUrl(base, detail.doc),
    payOnline: Boolean(payments.payable(db, business, detail).amount),
  });
  return { detail, data, filename: billing.pdfFilename(detail, language) };
}

function sendPdf(res, { data, filename }, download) {
  res.type('application/pdf');
  res.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(data);
}

function billingRouter(db) {
  const router = express.Router();
  router.use(requireUser);
  const adminOnly = (req) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can do that.');
  };
  const bid = (req) => req.user.business_id;
  const docId = (req) => billing.documentForUser(db, Number(req.params.id), req.user).id;

  router.get('/meta', (req, res) => {
    const b = req.business;
    res.json({
      settings: billing.getSettings(db, b.id),
      kinds: billing.CONTACT_KINDS,
      units: billing.UNITS,
      methods: billing.PAYMENT_METHODS,
      mail: Boolean(mailer()),
      logo: Boolean(logo.current(b.id)),
      plan: { premium: sites.isPremium(b), status: b.subscription_status || null, canUpgrade: Boolean(config.stripeEnabled && config.stripe.premiumPriceId), managed: Boolean(b.stripe_customer_id) },
      payments: payments.connectStatus(b),
      financing: {
        provider: config.financing.provider || null,
        enabled: Boolean(b.financing_enabled),
        ready: financing.providerReady(b),
        merchantId: b.wisetack_merchant_id || '',
        signupUrl: config.financing.wisetack.signupUrl || '',
        min: config.financing.minAmount,
        max: config.financing.maxAmount,
      },
    });
  });

  router.put('/settings', (req, res) => {
    adminOnly(req);
    res.json(billing.saveSettings(db, bid(req), req.body));
  });

  // Body: {data: "data:image/png;base64,…"}
  router.put('/settings/logo', (req, res) => {
    adminOnly(req);
    logo.save(bid(req), req.body.data);
    res.json({ ok: true });
  });

  router.delete('/settings/logo', (req, res) => {
    adminOnly(req);
    logo.remove(bid(req));
    res.json({ ok: true });
  });

  router.get('/logo', (req, res) => {
    const file = logo.current(bid(req));
    if (!file) throw new HttpError(404, 'Not found.');
    res.type(file.mime).set('Cache-Control', 'no-cache').send(fs.readFileSync(file.path));
  });

  // Turn customer financing on or off, with the business's Wisetack merchant ID.
  router.put('/settings/financing', (req, res) => {
    adminOnly(req);
    const merchantId = String(req.body.merchant_id ?? req.business.wisetack_merchant_id ?? '').trim().slice(0, 100);
    const enabled = Boolean(req.body.enabled);
    if (enabled && config.financing.provider === 'wisetack' && !merchantId) throw new HttpError(400, 'Enter your Wisetack merchant ID first.');
    db.prepare('UPDATE businesses SET financing_enabled = ?, wisetack_merchant_id = ? WHERE id = ?').run(enabled ? 1 : 0, merchantId || null, bid(req));
    res.json({ ok: true });
  });

  // ---- Customers ------------------------------------------------------------------------
  router.get('/contacts', (req, res) => res.json(billing.listContacts(db, bid(req), { archived: req.query.archived === '1' })));
  router.post('/contacts', (req, res) => res.status(201).json({ id: billing.saveContact(db, bid(req), null, req.body) }));
  router.put('/contacts/:id', (req, res) => res.json({ id: billing.saveContact(db, bid(req), Number(req.params.id), req.body) }));
  router.delete('/contacts/:id', (req, res) => {
    adminOnly(req);
    billing.deleteContact(db, bid(req), Number(req.params.id));
    res.json({ ok: true });
  });

  // ---- Price list -----------------------------------------------------------------------
  router.get('/items', (req, res) => res.json(billing.listItems(db, bid(req))));
  router.post('/items', (req, res) => res.status(201).json({ id: billing.saveItem(db, bid(req), null, req.body) }));
  router.put('/items/:id', (req, res) => res.json({ id: billing.saveItem(db, bid(req), Number(req.params.id), req.body) }));
  router.delete('/items/:id', (req, res) => {
    db.prepare('DELETE FROM catalog_items WHERE id = ? AND business_id = ?').run(Number(req.params.id), bid(req));
    res.json({ ok: true });
  });

  // ---- Quotes and invoices --------------------------------------------------------------
  router.get('/docs', (req, res) => {
    const userId = req.user.role === 'admin' ? null : req.user.id;
    const quotes = billing.listDocuments(db, bid(req), { type: 'quote', userId });
    const invoices = billing.listDocuments(db, bid(req), { type: 'invoice', userId });
    res.json({ quotes, invoices, summary: billing.summary(quotes, invoices) });
  });

  router.post('/docs', (req, res) => {
    res.status(201).json({ id: billing.createDocument(db, bid(req), req.body.type, req.body, req.user) });
  });

  router.get('/docs/:id', async (req, res) => {
    const id = docId(req);
    let app = financing.latestApplication(db, id);
    if (app) app = await financing.refresh(db, req.business, app);
    const detail = billing.documentDetail(db, id);
    res.json({
      ...detail,
      public_url: billing.publicUrl(baseUrl(req), detail.doc),
      online: payments.payable(db, req.business, detail),
      financing: { ...financing.financeable(req.business, detail), application: app ? { status: app.status, label: financing.STATUS_LABEL[app.status], amount: app.amount, updated_at: app.updated_at } : null },
    });
  });

  router.put('/docs/:id', (req, res) => {
    billing.updateDocument(db, bid(req), docId(req), req.body);
    res.json({ ok: true });
  });

  router.delete('/docs/:id', (req, res) => {
    db.prepare('DELETE FROM documents WHERE id = ?').run(docId(req));
    res.json({ ok: true });
  });

  router.post('/docs/:id/duplicate', (req, res) => {
    res.status(201).json({ id: billing.duplicateDocument(db, bid(req), docId(req), req.user) });
  });

  router.post('/docs/:id/convert', (req, res) => {
    res.status(201).json(billing.convertToInvoice(db, bid(req), docId(req), req.user));
  });

  // Body: {status, name}; name is who approved, or why it was declined.
  router.post('/docs/:id/status', (req, res) => {
    billing.setStatus(db, docId(req), req.body, req.user);
    res.json({ ok: true });
  });

  // Sent some other way (text message, printed, link copied): just record it.
  router.post('/docs/:id/mark-sent', (req, res) => {
    billing.markSent(db, docId(req), req.body.to ? String(req.body.to).slice(0, 500) : null);
    res.json({ ok: true });
  });

  // Body: {to, cc, message, language}. Emails the PDF, in the customer's language, with a link to
  // view, approve and pay it online.
  router.post('/docs/:id/send', async (req, res) => {
    const id = docId(req);
    const send = mailer();
    if (!send) throw new HttpError(409, "Email isn't set up in this app yet. Download the PDF or copy the link and send it yourself.");
    const to = parseEmails(req.body.to);
    const cc = parseEmails(req.body.cc);
    if (!to.length) throw new HttpError(400, 'Enter an email address to send it to.');
    const bad = [...to, ...cc].filter((e) => !isEmail(e));
    if (bad.length) throw new HttpError(400, 'Not a valid email address: {list}', { list: bad.join(', ') });
    const lang = ['en', 'es'].includes(req.body.language) ? req.body.language : undefined;
    const pdf = await pdfFor(db, req.business, id, baseUrl(req), lang);
    const { doc, totals } = pdf.detail;
    const language = lang || doc.language;
    const t = (text, params) => tr(language, text, params);
    const settings = billing.getSettings(db, bid(req));
    const label = t(billing.TYPE_LABEL[doc.type]);
    const link = `${billing.publicUrl(baseUrl(req), doc)}?lang=${language}`;
    const canPay = Boolean(payments.payable(db, req.business, pdf.detail).amount);
    const amount = doc.type === 'invoice'
      ? t('Amount due: {amount}', { amount: `<strong>${billing.fmtMoney(totals.balance, language)}</strong>` }) + (doc.due_date ? ` · ${t('Due: {date}', { date: billing.fmtDate(doc.due_date, language) })}` : '')
      : t('Total: {amount}', { amount: `<strong>${billing.fmtMoney(totals.total, language)}</strong>` });
    const message = String(req.body.message ?? '').trim();
    const button = doc.type === 'quote' ? t('View and approve the quote') : canPay ? t('View and pay the invoice') : t('View the invoice');
    const html = `${message ? `<p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>` : ''}
<p>${escapeHtml(label)} ${escapeHtml(doc.number)}${doc.title ? ` — ${escapeHtml(doc.title)}` : ''}<br>${amount}</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#1d4e89;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">${escapeHtml(button)}</a></p>
<p>${escapeHtml(t('The {what} is also attached as a PDF.', { what: label.toLowerCase() }))}</p>
<p>${escapeHtml(settings.company_name || req.user.name)}${settings.company_phone ? `<br>${escapeHtml(settings.company_phone)}` : ''}${settings.company_email ? `<br>${escapeHtml(settings.company_email)}` : ''}</p>`;
    try {
      await send({
        to,
        cc,
        replyTo: req.user.email,
        fromName: settings.company_name || undefined,
        subject: t(doc.title ? '{what} {number} from {company}: {title}' : '{what} {number} from {company}', { what: label, number: doc.number, company: settings.company_name || req.user.name, title: doc.title }),
        html,
        attachments: [{ name: pdf.filename, contentType: 'application/pdf', content: pdf.data }],
      });
    } catch (err) {
      console.error(err);
      throw new HttpError(502, "The email couldn't be sent: {reason}", { reason: err.message });
    }
    billing.markSent(db, id, to.join(', '));
    res.json({ ok: true });
  });

  router.post('/docs/:id/payments', (req, res) => {
    billing.addPayment(db, docId(req), req.body, req.user);
    res.status(201).json({ ok: true });
  });

  // Payments made online or by a lender came from outside the app, so they can't be removed here.
  router.delete('/docs/:id/payments/:paymentId', (req, res) => {
    const id = docId(req);
    const p = db.prepare('SELECT * FROM payments WHERE id = ? AND document_id IN (SELECT id FROM documents WHERE business_id = ?)').get(Number(req.params.paymentId), bid(req));
    if (!p) throw new HttpError(404, 'Not found.');
    if (p.source !== 'manual') throw new HttpError(409, 'Online and financed payments can only be refunded from Stripe or the lender.');
    db.prepare('DELETE FROM payments WHERE id = ? AND document_id = ?').run(p.id, id);
    res.json({ ok: true });
  });

  router.get('/docs/:id/pdf', async (req, res) => {
    const lang = ['en', 'es'].includes(req.query.lang) ? req.query.lang : undefined;
    sendPdf(res, await pdfFor(db, req.business, docId(req), baseUrl(req), lang), req.query.download === '1');
  });

  return router;
}

module.exports = { billingRouter, pdfFor, sendPdf };
