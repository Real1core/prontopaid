// The business's landing page editor (Premium), its leads, and the notification bell.
const express = require('express');
const { requireUser } = require('../auth');
const { HttpError, baseUrl } = require('../util');
const sites = require('../sites');
const billing = require('../billing');
const notifications = require('../notify');

function sitesRouter(db) {
  const router = express.Router();
  router.use(requireUser);
  const adminOnly = (req) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can do that.');
  };
  const view = (req, site) => ({ ...site, url: `${baseUrl(req)}/s/${site.slug}`, premium: sites.isPremium(req.business) });

  // ---- Landing page ---------------------------------------------------------------------
  router.get('/site', (req, res) => res.json(view(req, sites.getSite(db, req.business))));

  router.put('/site', (req, res) => {
    adminOnly(req);
    res.json(view(req, sites.saveSite(db, req.business, req.body)));
  });

  router.put('/site/photo', (req, res) => {
    adminOnly(req);
    sites.savePhoto(db, req.business, req.body.data);
    res.json(view(req, sites.getSite(db, req.business)));
  });

  router.delete('/site/photo', (req, res) => {
    adminOnly(req);
    sites.removePhoto(db, req.business);
    res.json(view(req, sites.getSite(db, req.business)));
  });

  // ---- Leads ----------------------------------------------------------------------------
  router.get('/leads', (req, res) => res.json(sites.listLeads(db, req.user.business_id)));

  router.put('/leads/:id', (req, res) => {
    sites.setLeadStatus(db, req.user.business_id, Number(req.params.id), req.body.status);
    res.json({ ok: true });
  });

  router.delete('/leads/:id', (req, res) => {
    adminOnly(req);
    db.prepare('DELETE FROM leads WHERE id = ? AND business_id = ?').run(Number(req.params.id), req.user.business_id);
    res.json({ ok: true });
  });

  // Make the lead a customer (or find them, by email) and start a quote for them.
  router.post('/leads/:id/quote', (req, res) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(Number(req.params.id), req.user.business_id);
    if (!lead) throw new HttpError(404, 'Not found.');
    let contactId = lead.contact_id;
    if (!contactId && lead.email) contactId = db.prepare('SELECT id FROM contacts WHERE business_id = ? AND email = ? COLLATE NOCASE').get(lead.business_id, lead.email)?.id;
    if (!contactId) {
      contactId = billing.saveContact(db, lead.business_id, null, { name: lead.name, email: lead.email, phone: lead.phone, address: lead.address, language: lead.language, kind: 'client', notes: lead.message });
    }
    db.prepare("UPDATE leads SET contact_id = ?, status = CASE WHEN status = 'new' OR status = 'contacted' THEN 'quoted' ELSE status END WHERE id = ?").run(contactId, lead.id);
    res.json({ contact_id: contactId, job_address: lead.address, title: lead.service });
  });

  // ---- Notifications --------------------------------------------------------------------
  router.get('/notifications', (req, res) => res.json(notifications.listFor(db, req.user)));

  router.post('/notifications/read', (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : null;
    if (ids) {
      const mark = db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ?");
      db.transaction(() => ids.forEach((id) => mark.run(id, req.user.id)))();
    } else db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { sitesRouter };
