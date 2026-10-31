// Premium: a simple landing page for each business at /s/<slug>, in English and Spanish, with a
// "get a free quote" form. Each request becomes a lead in the app and a notice on the bell.
// The page is plain HTML built here (no JavaScript needed), so it's fast and search engines read it.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { HttpError, msg, isEmail, escapeHtml } = require('./util');
const { tr, pick, LANGS } = require('../public/i18n');
const logo = require('./logo');

const RESERVED = new Set(['api', 'admin', 'app', 'www', 's', 'auth', 'login', 'signup', 'prontopaid', 'help', 'support', 'static']);
const TEXT_FIELDS = { headline: 120, tagline: 240, about: 3000, cta: 60 };
const MAX_SERVICES = 12;
const LEAD_STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost'];

const isPremium = (business) => config.premiumForAll || business.plan === 'premium';

/** "Ortiz Plumbing & Sons" -> "ortiz-plumbing-sons" */
const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function uniqueSlug(db, base, businessId) {
  let slug = slugify(base) || 'my-business';
  if (slug.length < 3) slug = `${slug}-pro`;
  let candidate = slug;
  for (let n = 2; RESERVED.has(candidate) || db.prepare('SELECT 1 FROM sites WHERE slug = ? AND business_id != ?').get(candidate, businessId); n++) candidate = `${slug}-${n}`;
  return candidate;
}

function parse(row) {
  return { ...row, published: Boolean(row.published), content: JSON.parse(row.content || '{}') };
}

/** The business's page, made with sensible defaults the first time. */
function getSite(db, business) {
  let row = db.prepare('SELECT * FROM sites WHERE business_id = ?').get(business.id);
  if (!row) {
    const content = {
      en: { headline: business.name, tagline: 'Quality work, fair prices, done right.', about: '', services: [], cta: 'Get a free quote' },
      es: { headline: business.name, tagline: 'Trabajo de calidad, precios justos, bien hecho.', about: '', services: [], cta: 'Pida una cotización gratis' },
    };
    db.prepare('INSERT INTO sites (business_id, slug, content) VALUES (?, ?, ?)').run(business.id, uniqueSlug(db, business.name, business.id), JSON.stringify(content));
    row = db.prepare('SELECT * FROM sites WHERE business_id = ?').get(business.id);
  }
  return parse(row);
}

function saveSite(db, business, body) {
  const current = getSite(db, business);
  const errors = [];
  const slug = body.slug === undefined ? current.slug : slugify(body.slug);
  if (slug.length < 3) errors.push(msg('The web address needs at least 3 letters or numbers.'));
  else if (RESERVED.has(slug) || db.prepare('SELECT 1 FROM sites WHERE slug = ? AND business_id != ?').get(slug, business.id)) errors.push(msg('That web address is taken. Try another.'));
  const content = {};
  for (const lang of LANGS) {
    const src = (body.content && body.content[lang]) || current.content[lang] || {};
    content[lang] = Object.fromEntries(Object.entries(TEXT_FIELDS).map(([k, max]) => [k, String(src[k] ?? '').trim().slice(0, max)]));
    content[lang].services = (Array.isArray(src.services) ? src.services : String(src.services || '').split('\n'))
      .map((s) => String(s).trim().slice(0, 80)).filter(Boolean).slice(0, MAX_SERVICES);
  }
  if (!content.en.headline && !content.es.headline) errors.push(msg('Add a headline.'));
  const email = String(body.email ?? current.email).trim().slice(0, 200);
  if (email && !isEmail(email)) errors.push(msg('Email is not a valid email address.'));
  const color = /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : current.color;
  const published = body.published === undefined ? current.published : Boolean(body.published);
  if (published && !isPremium(business)) errors.push(msg('Publishing your page is part of Premium.'));
  if (errors.length) throw new HttpError(400, errors);
  db.prepare(`UPDATE sites SET slug = ?, published = ?, content = ?, phone = ?, email = ?, service_area = ?, color = ?, default_language = ?, updated_at = datetime('now') WHERE business_id = ?`)
    .run(slug, published ? 1 : 0, JSON.stringify(content), String(body.phone ?? current.phone).trim().slice(0, 40), email,
      String(body.service_area ?? current.service_area).trim().slice(0, 300), color, pick(body.default_language ?? current.default_language), business.id);
  return getSite(db, business);
}

// ---- The page's photo ----------------------------------------------------------------------

const photoDir = () => path.join(config.dataDir, 'site-photos');

function savePhoto(db, business, dataUrl) {
  const img = logo.decodeImage(dataUrl, 6 * 1024 * 1024);
  const site = getSite(db, business);
  if (site.photo) fs.rmSync(path.join(photoDir(), path.basename(site.photo)), { force: true });
  fs.mkdirSync(photoDir(), { recursive: true });
  const file = `${business.id}-${Date.now()}.${img.ext}`;
  fs.writeFileSync(path.join(photoDir(), file), img.data);
  db.prepare("UPDATE sites SET photo = ?, updated_at = datetime('now') WHERE business_id = ?").run(file, business.id);
}

function removePhoto(db, business) {
  const site = getSite(db, business);
  if (site.photo) fs.rmSync(path.join(photoDir(), path.basename(site.photo)), { force: true });
  db.prepare('UPDATE sites SET photo = NULL WHERE business_id = ?').run(business.id);
}

const photoPath = (site) => (site.photo ? path.join(photoDir(), path.basename(site.photo)) : null);

/** A published page by its address, with its business, or null (unpublished, or Premium ended). */
function publicSite(db, slug) {
  const row = db.prepare('SELECT * FROM sites WHERE slug = ?').get(String(slug).toLowerCase());
  if (!row || !row.published) return null;
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(row.business_id);
  if (!business || !isPremium(business)) return null;
  return { site: parse(row), business };
}

// ---- Leads ---------------------------------------------------------------------------------

/** A request from the page's form. Returns the lead, or throws with what to fix. */
function createLead(db, site, body, lang) {
  const v = (k, max = 200) => String(body[k] ?? '').trim().slice(0, max);
  const lead = { name: v('name', 100), phone: v('phone', 40), email: v('email'), service: v('service', 100), address: v('address', 300), message: v('message', 3000) };
  const errors = [];
  if (!lead.name) errors.push(msg('Please enter your name.'));
  if (!lead.phone && !lead.email) errors.push(msg('Please enter a phone number or email so we can reach you.'));
  if (lead.email && !isEmail(lead.email)) errors.push(msg('Email is not a valid email address.'));
  if (errors.length) throw new HttpError(400, errors);
  const id = Number(db.prepare('INSERT INTO leads (business_id, name, phone, email, service, address, message, language) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(site.business_id, lead.name, lead.phone, lead.email, lead.service, lead.address, lead.message, pick(lang)).lastInsertRowid);
  return { id, ...lead };
}

const listLeads = (db, businessId) => db.prepare('SELECT * FROM leads WHERE business_id = ? ORDER BY id DESC').all(businessId);

function setLeadStatus(db, businessId, id, status) {
  if (!LEAD_STATUSES.includes(status)) throw new HttpError(400, 'Unknown status.');
  const r = db.prepare('UPDATE leads SET status = ? WHERE id = ? AND business_id = ?').run(status, id, businessId);
  if (!r.changes) throw new HttpError(404, 'Not found.');
}

// ---- The public page -----------------------------------------------------------------------

/**
 * The landing page's HTML.
 * @param {object} p
 * @param {object} p.site  publicSite().site
 * @param {object} p.business
 * @param {object} p.settings billing settings (address, license…)
 * @param {string} p.lang
 * @param {string} p.base  the app's address, for canonical and language links
 * @param {object} [p.form] {sent: true} or {error, values} after a submission
 */
function renderSite({ site, business, settings, lang, base, form = {} }) {
  const t = (text, params) => escapeHtml(tr(lang, text, params));
  const e = escapeHtml;
  const other = lang === 'es' ? 'en' : 'es';
  // Text in this language, or the other one if it's blank.
  const c = { ...site.content[other], ...Object.fromEntries(Object.entries(site.content[lang] || {}).filter(([, v]) => (Array.isArray(v) ? v.length : v))) };
  const services = c.services || [];
  const phone = site.phone || settings.company_phone;
  const email = site.email || settings.company_email;
  const url = `${base}/s/${site.slug}`;
  const hasLogo = Boolean(logo.current(business.id));
  const values = form.values || {};
  const field = (name, label, attrs = '') => `<label>${t(label)}<input name="${name}" value="${e(values[name] || '')}" ${attrs}></label>`;
  const color = site.color;

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(c.headline || business.name)}${c.headline && c.headline !== business.name ? ` · ${e(business.name)}` : ''}</title>
<meta name="description" content="${e(c.tagline || '')}">
<link rel="canonical" href="${e(url)}?lang=${lang}">
<link rel="alternate" hreflang="${other}" href="${e(url)}?lang=${other}">
<meta property="og:title" content="${e(c.headline || business.name)}">
<meta property="og:description" content="${e(c.tagline || '')}">
${site.photo ? `<meta property="og:image" content="${e(url)}/photo">` : ''}
<style>
:root { --c: ${color}; --text: #1f2933; --muted: #5b6673; --bg: #f6f7f9; --border: #dde2e8; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--text); background: #fff; }
a { color: var(--c); }
.wrap { max-width: 1040px; margin: 0 auto; padding: 0 20px; }
header.top { display: flex; align-items: center; gap: 12px; padding: 14px 0; }
header.top img { max-height: 48px; max-width: 180px; object-fit: contain; }
header.top .name { font-weight: 800; font-size: 1.15rem; }
.spacer { flex: 1; }
.lang a { font-weight: 700; text-decoration: none; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border); color: var(--text); font-size: 0.9rem; }
.hero { position: relative; color: #fff; background: var(--c); ${site.photo ? `background-image: linear-gradient(rgba(0,0,0,.55), rgba(0,0,0,.55)), url("/s/${e(site.slug)}/photo"); background-size: cover; background-position: center;` : ''} }
.hero .wrap { padding-top: 72px; padding-bottom: 72px; }
.hero h1 { font-size: clamp(2rem, 5vw, 3.2rem); line-height: 1.1; margin: 0 0 12px; }
.hero p { font-size: 1.2rem; max-width: 640px; margin: 0 0 24px; opacity: 0.95; }
.btn { display: inline-block; padding: 14px 22px; border-radius: 10px; font-weight: 700; text-decoration: none; border: 0; cursor: pointer; font-size: 1rem; }
.btn.primary { background: #fff; color: var(--c); }
.btn.ghost { color: #fff; border: 2px solid rgba(255,255,255,.7); margin-left: 8px; }
section { padding: 48px 0; }
section.alt { background: var(--bg); }
h2 { font-size: 1.6rem; margin: 0 0 16px; }
.services { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; list-style: none; padding: 0; margin: 0; }
.services li { background: #fff; border: 1px solid var(--border); border-left: 4px solid var(--c); border-radius: 10px; padding: 14px 16px; font-weight: 600; }
.about { white-space: pre-wrap; max-width: 720px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
@media (max-width: 760px) { .cols { grid-template-columns: 1fr; } .btn.ghost { margin: 10px 0 0; } }
form.card { background: #fff; border: 1px solid var(--border); border-radius: 14px; padding: 20px; box-shadow: 0 2px 10px rgba(16,24,40,.06); }
label { display: block; font-weight: 600; font-size: 0.92rem; margin: 12px 0 4px; }
input, select, textarea { display: block; width: 100%; margin-top: 4px; font: inherit; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; }
textarea { min-height: 110px; }
form .btn { background: var(--c); color: #fff; width: 100%; margin-top: 16px; }
.hp { position: absolute; left: -9999px; }
.ok { background: #e8f5e9; color: #2f7d32; border-radius: 10px; padding: 16px; font-weight: 600; }
.err { background: #fdecec; color: #b91c1c; border-radius: 10px; padding: 12px 14px; margin-bottom: 8px; }
.contact p { margin: 6px 0; }
footer { padding: 24px 0 40px; color: var(--muted); font-size: 0.85rem; text-align: center; }
</style>
</head>
<body>
<header class="wrap top">
  ${hasLogo ? `<img src="/s/${e(site.slug)}/logo" alt="${e(business.name)}">` : `<span class="name">${e(business.name)}</span>`}
  <span class="spacer"></span>
  <nav class="lang"><a href="?lang=${other}" hreflang="${other}" lang="${other}">${other === 'es' ? 'Español' : 'English'}</a></nav>
</header>
<div class="hero"><div class="wrap">
  <h1>${e(c.headline || business.name)}</h1>
  ${c.tagline ? `<p>${e(c.tagline)}</p>` : ''}
  <a class="btn primary" href="#quote">${e(c.cta || tr(lang, 'Get a free quote'))}</a>
  ${phone ? `<a class="btn ghost" href="tel:${e(phone.replace(/[^\d+]/g, ''))}">${t('Call {phone}', { phone })}</a>` : ''}
</div></div>
${services.length ? `<section><div class="wrap"><h2>${t('Our services')}</h2><ul class="services">${services.map((s) => `<li>${e(s)}</li>`).join('')}</ul></div></section>` : ''}
${c.about ? `<section class="alt"><div class="wrap"><h2>${t('About us')}</h2><p class="about">${e(c.about)}</p></div></section>` : ''}
<section id="quote"><div class="wrap cols">
  <div class="contact">
    <h2>${e(c.cta || tr(lang, 'Get a free quote'))}</h2>
    <p>${t('Tell us about your project and we will get back to you soon.')}</p>
    ${phone ? `<p><strong>${t('Phone')}:</strong> <a href="tel:${e(phone.replace(/[^\d+]/g, ''))}">${e(phone)}</a></p>` : ''}
    ${email ? `<p><strong>${t('Email')}:</strong> <a href="mailto:${e(email)}">${e(email)}</a></p>` : ''}
    ${site.service_area ? `<p><strong>${t('Service area')}:</strong> ${e(site.service_area)}</p>` : ''}
    ${settings.license_number ? `<p><strong>${t('License #')}</strong> ${e(settings.license_number)}</p>` : ''}
  </div>
  ${form.sent ? `<div class="ok">${t('Thank you! We received your request and will contact you soon.')}</div>` : `
  <form class="card" method="post" action="/s/${e(site.slug)}/contact">
    ${form.error ? `<div class="err" role="alert">${e(form.error)}</div>` : ''}
    <input type="hidden" name="lang" value="${lang}">
    <label class="hp" aria-hidden="true">Website<input name="company_website" tabindex="-1" autocomplete="off"></label>
    ${field('name', 'Your name', 'required autocomplete="name"')}
    ${field('phone', 'Phone', 'type="tel" autocomplete="tel"')}
    ${field('email', 'Email', 'type="email" autocomplete="email"')}
    ${services.length ? `<label>${t('Service needed')}<select name="service"><option value="">${t('Choose one')}</option>${services.map((s) => `<option${values.service === s ? ' selected' : ''}>${e(s)}</option>`).join('')}<option value="${t('Other')}">${t('Other')}</option></select></label>` : ''}
    ${field('address', 'Project address', 'autocomplete="street-address"')}
    <label>${t('Project details')}<textarea name="message">${e(values.message || '')}</textarea></label>
    <button class="btn" type="submit">${t('Send request')}</button>
  </form>`}
</div></section>
<footer>© ${new Date().getFullYear()} ${e(business.name)} · ${t('Website by ProntoPaid')}</footer>
</body>
</html>`;
}

module.exports = { LEAD_STATUSES, isPremium, slugify, getSite, saveSite, savePhoto, removePhoto, photoPath, publicSite, createLead, listLeads, setLeadStatus, renderSite };
