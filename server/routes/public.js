// What customers and website visitors use, without signing in, in English or Spanish:
// - the link to a quote or invoice: view it, approve or decline, pay online, apply for financing,
//   download the PDF;
// - the pretend lender, when FINANCING_PROVIDER=test;
// - a business's landing page (/s/<slug>) and its contact form.
const fs = require('fs');
const express = require('express');
const config = require('../config');
const { HttpError, requestLang, browserLang, baseUrl } = require('../util');
const { tr, pick } = require('../../public/i18n');
const billing = require('../billing');
const payments = require('../payments');
const financing = require('../financing');
const sites = require('../sites');
const logo = require('../logo');
const { notify } = require('../notify');
const { pdfFor, sendPdf } = require('./billing');
const { financingChanged } = require('./payments');

function publicRouter(db) {
  const router = express.Router();

  // Drafts aren't shown: the link only works once it's been sent.
  const byToken = (token) => {
    const row = db.prepare("SELECT id, business_id FROM documents WHERE public_token = ? AND status != 'draft'").get(String(token));
    if (!row) throw new HttpError(404, "This link isn't valid any more. Ask the sender for a new one.");
    return { detail: billing.documentDetail(db, row.id), business: db.prepare('SELECT * FROM businesses WHERE id = ?').get(row.business_id) };
  };

  router.get('/docs/:token', (req, res) => {
    const { detail, business } = byToken(req.params.token);
    const { doc, lines, payments: paid, contact, totals } = detail;
    if (!doc.viewed_at) db.prepare("UPDATE documents SET viewed_at = datetime('now') WHERE id = ?").run(doc.id);
    const s = billing.getSettings(db, business.id);
    const online = payments.payable(db, business, detail);
    const fin = financing.financeable(business, detail);
    const app = financing.latestApplication(db, doc.id);
    res.json({
      company: {
        logo: Boolean(logo.current(business.id)), name: s.company_name, address: s.company_address, phone: s.company_phone, email: s.company_email,
        website: s.company_website, license_number: s.license_number,
        payment_instructions: s.payment_instructions, payment_instructions_es: s.payment_instructions_es,
      },
      doc: {
        type: doc.type, number: doc.number, title: doc.title, job_address: doc.job_address, issue_date: doc.issue_date, due_date: doc.due_date,
        discount_type: doc.discount_type, discount_value: doc.discount_value, tax_rate: doc.tax_rate, deposit_percent: doc.deposit_percent,
        notes: doc.notes, terms: doc.terms, display_status: doc.display_status, status_label: doc.status_label, language: doc.language,
        approved_at: doc.approved_at, approved_name: doc.approved_name, declined_at: doc.declined_at,
        can_respond: doc.type === 'quote' && ['sent', 'viewed', 'expired'].includes(doc.display_status),
      },
      contact: contact ? { name: contact.name, company: contact.company } : null,
      lines: lines.map(({ name, description, quantity, unit, unit_price, taxable }) => ({ name, description, quantity, unit, unit_price, taxable })),
      payments: paid.map(({ amount, paid_on, method }) => ({ amount, paid_on, method })),
      pending: detail.pending_payments.map(({ amount, method }) => ({ amount, method })),
      totals,
      pay: { amount: online.amount, kind: online.kind },
      financing: {
        amount: fin.amount,
        provider: config.financing.provider,
        application: app ? { status: app.status, label: financing.STATUS_LABEL[app.status], amount: app.amount } : null,
      },
    });
  });

  router.get('/docs/:token/logo', (req, res) => {
    const { business } = byToken(req.params.token);
    const file = logo.current(business.id);
    if (!file) throw new HttpError(404, 'Not found.');
    res.type(file.mime).set('Cache-Control', 'no-cache').send(fs.readFileSync(file.path));
  });

  const respond = (req) => {
    const found = byToken(req.params.token);
    if (found.detail.doc.type !== 'quote') throw new HttpError(400, 'Only quotes can be approved.');
    if (!['sent', 'viewed', 'expired'].includes(found.detail.doc.display_status)) {
      throw new HttpError(409, 'This quote is already {status}.', { status: tr(requestLang(req), found.detail.doc.status_label).toLowerCase() });
    }
    return found;
  };

  router.post('/docs/:token/approve', async (req, res) => {
    const { detail, business } = respond(req);
    const name = String(req.body.name ?? '').trim().slice(0, 200);
    if (!name) throw new HttpError(400, 'Type your full name to approve.');
    db.prepare("UPDATE documents SET status = 'approved', approved_at = datetime('now'), approved_name = ?, updated_at = datetime('now') WHERE id = ?").run(name, detail.doc.id);
    await notify(db, business.id, {
      kind: 'approved',
      text: '{name} approved quote {number} for {amount}',
      params: { name, number: detail.doc.number, amount: billing.fmtMoney(detail.totals.total) },
      link: `#/doc/${detail.doc.id}`,
      base: baseUrl(req),
      only: { userId: detail.doc.created_by },
    });
    res.json({ ok: true });
  });

  router.post('/docs/:token/decline', async (req, res) => {
    const { detail, business } = respond(req);
    const reason = String(req.body.reason ?? '').trim().slice(0, 2000);
    db.prepare("UPDATE documents SET status = 'declined', declined_at = datetime('now'), decline_reason = ?, updated_at = datetime('now') WHERE id = ?").run(reason || null, detail.doc.id);
    await notify(db, business.id, {
      kind: 'declined',
      text: reason ? 'Quote {number} was declined: "{reason}"' : 'Quote {number} was declined',
      params: { number: detail.doc.number, reason },
      link: `#/doc/${detail.doc.id}`,
      base: baseUrl(req),
      only: { userId: detail.doc.created_by },
    });
    res.json({ ok: true });
  });

  // Pay online: returns the Stripe page to go to.
  router.post('/docs/:token/pay', async (req, res) => {
    const { detail, business } = byToken(req.params.token);
    const url = await payments.startCheckout(db, business, detail, { base: baseUrl(req), lang: requestLang(req) });
    if (!url) throw new HttpError(409, 'There is nothing to pay online right now.');
    res.json({ url });
  });

  // Pay over time: returns the lender's application page.
  router.post('/docs/:token/finance', async (req, res) => {
    const { detail, business } = byToken(req.params.token);
    const app = await financing.apply(db, business, detail, { base: baseUrl(req), lang: requestLang(req) });
    res.json({ url: app.apply_url });
  });

  router.get('/docs/:token/pdf', async (req, res) => {
    const { detail, business } = byToken(req.params.token);
    const lang = ['en', 'es'].includes(req.query.lang) ? req.query.lang : undefined;
    sendPdf(res, await pdfFor(db, business, detail.doc.id, baseUrl(req), lang), req.query.download === '1');
  });

  // ---- The pretend lender (FINANCING_PROVIDER=test) -------------------------------------
  const testApp = (req) => {
    if (config.financing.provider !== 'test') throw new HttpError(404, 'Not found.');
    const { detail, business } = byToken(req.params.token);
    const app = db.prepare("SELECT * FROM financing_applications WHERE id = ? AND document_id = ? AND provider = 'test'").get(Number(req.params.appId), detail.doc.id);
    if (!app) throw new HttpError(404, 'Not found.');
    return { app, detail, business };
  };

  router.get('/finance-test/:token/:appId', (req, res) => {
    const { app, detail, business } = testApp(req);
    res.json({ status: app.status, amount: app.amount, number: detail.doc.number, company: business.name });
  });

  // Body: {decision: 'approved' | 'declined' | 'accepted' | 'funded'}. Each step as a lender would report it.
  router.post('/finance-test/:token/:appId', async (req, res) => {
    const { app } = testApp(req);
    const order = ['started', 'approved', 'accepted', 'funded'];
    const decision = req.body.decision;
    if (decision === 'declined') await financingChanged(db, app, 'declined', 'TEST_DECLINED', baseUrl(req));
    else if (order.includes(decision)) {
      // Walk through the steps a real lender reports, so each notice and status is seen.
      for (const step of order.slice(order.indexOf(app.status) + 1, order.indexOf(decision) + 1)) {
        await financingChanged(db, db.prepare('SELECT * FROM financing_applications WHERE id = ?').get(app.id), step, `TEST_${step.toUpperCase()}`, baseUrl(req));
      }
    } else throw new HttpError(400, 'Unknown status.');
    res.json({ status: db.prepare('SELECT status FROM financing_applications WHERE id = ?').get(app.id).status });
  });

  return router;
}

// ---- Landing pages: /s/<slug> ----------------------------------------------------------------

function siteRouter(db) {
  const router = express.Router();
  // Each visitor (by address) may send a few requests per hour; more is almost always spam.
  const sentBy = new Map();
  const LIMIT = 5;
  const WINDOW = 60 * 60 * 1000;

  const found = (req) => {
    const s = sites.publicSite(db, req.params.slug);
    if (!s) throw new HttpError(404, 'Not found.');
    return s;
  };
  const langOf = (req, site) => pick(req.query.lang || req.body?.lang || browserLang(req) || site.default_language);
  const page = (req, res, form) => {
    let s;
    try {
      s = found(req);
    } catch {
      return res.status(404).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>404</title><p style="font:16px sans-serif;padding:2rem">${tr(pick(req.query.lang), 'This page is not available.')}</p>`);
    }
    const lang = langOf(req, s.site);
    res.type('html').set('Content-Language', lang).send(sites.renderSite({ ...s, settings: billing.getSettings(db, s.business.id), lang, base: baseUrl(req), form: form || { sent: req.query.sent === '1' } }));
  };

  router.get('/:slug', (req, res) => page(req, res));

  router.post('/:slug/contact', express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
    const s = found(req);
    const lang = langOf(req, s.site);
    // A hidden field people never see: bots fill it in. Pretend it worked.
    if (req.body.company_website) return res.redirect(303, `/s/${s.site.slug}?lang=${lang}&sent=1#quote`);
    const key = req.ip;
    const now = Date.now();
    const recent = (sentBy.get(key) || []).filter((t) => now - t < WINDOW);
    if (recent.length >= LIMIT) return page(req, res, { error: tr(lang, 'Too many requests. Please call us instead.'), values: req.body });
    let lead;
    try {
      lead = sites.createLead(db, s.site, req.body, lang);
    } catch (err) {
      if (err instanceof HttpError) return page(req, res, { error: err.translated(lang), values: req.body });
      throw err;
    }
    sentBy.set(key, [...recent, now]);
    await notify(db, s.business.id, {
      kind: 'lead',
      text: lead.service ? 'New lead: {name} ({service})' : 'New lead: {name}',
      params: { name: lead.name, service: lead.service },
      link: '#/?tab=leads',
      base: baseUrl(req),
    });
    res.redirect(303, `/s/${s.site.slug}?lang=${lang}&sent=1#quote`);
  });

  router.get('/:slug/photo', (req, res) => {
    const file = sites.photoPath(found(req).site);
    if (!file || !fs.existsSync(file)) throw new HttpError(404, 'Not found.');
    res.type(file.endsWith('.png') ? 'image/png' : 'image/jpeg').set('Cache-Control', 'public, max-age=3600').send(fs.readFileSync(file));
  });

  router.get('/:slug/logo', (req, res) => {
    const file = logo.current(found(req).business.id);
    if (!file) throw new HttpError(404, 'Not found.');
    res.type(file.mime).set('Cache-Control', 'public, max-age=3600').send(fs.readFileSync(file.path));
  });

  return router;
}

module.exports = { publicRouter, siteRouter };
