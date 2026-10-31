'use strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $app = document.getElementById('app');
const state = { user: null, business: null, companyName: '' };

// ---- Language: English or Spanish, chosen in the menu (signed in) or on the page (customers) ----
let lang = (() => {
  try {
    return I18N.pick(localStorage.getItem('lang') || (navigator.language || '').slice(0, 2));
  } catch {
    return 'en';
  }
})();
const t = (text, params) => I18N.tr(lang, text, params);
const locale = () => I18N.LOCALE[lang];

function setLang(next, { save = true } = {}) {
  lang = I18N.pick(next);
  document.documentElement.lang = lang;
  if (save) {
    try {
      localStorage.setItem('lang', lang);
    } catch {}
  }
}
setLang(lang, { save: false });

/** "English | Español" buttons; changing the language redraws the page. */
function langSwitch(onChange) {
  return h('div', { class: 'lang-switch', role: 'group', 'aria-label': 'Language / Idioma' },
    [['en', 'English'], ['es', 'Español']].map(([code, label]) => h('button', {
      type: 'button',
      class: lang === code ? 'active' : '',
      'aria-pressed': String(lang === code),
      lang: code,
      onclick: async () => {
        if (lang === code) return;
        setLang(code);
        if (onChange) await onChange(code);
        // A link that names a language (?lang=es) is updated, so the choice sticks.
        if (/[?&]lang=/.test(location.hash)) location.hash = location.hash.replace(/([?&]lang=)\w+/, `$1${code}`);
        else route();
      },
    }, label)));
}

/** Create an element: h('div', {class: 'x', onclick: fn}, 'text', child, [children]) */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'value') el.value = value;
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  const add = (child) => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) child.forEach(add);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  };
  children.forEach(add);
  return el;
}

/** Replace an element's children; accepts nested arrays and skips null/false like h(). */
function fill(el, ...children) {
  el.replaceChildren(...h('div', {}, children).childNodes);
}

async function api(method, url, body) {
  const opts = { method, headers: { 'X-Lang': lang } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error(t('No connection. Check your internet and try again.'));
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && !url.startsWith('/auth/') && state.user) {
    state.user = null;
    location.hash = '#/signin';
  }
  if (!res.ok) {
    const err = new Error(data?.error || t('Request failed ({status})', { status: res.status }));
    err.status = res.status;
    throw err;
  }
  return data;
}

const showError = (err) => toast(err.message, true);

let toastTimer;
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3000);
}

function modal(...content) {
  const backdrop = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, ...content));
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  document.body.append(backdrop);
  return { el: backdrop, close: () => backdrop.remove() };
}

function confirmDialog(title, message, okLabel = t('OK')) {
  return new Promise((resolve) => {
    const m = modal(
      h('h2', {}, title),
      h('p', {}, message),
      h('div', { class: 'modal-actions' },
        h('button', { onclick: () => { m.close(); resolve(false); } }, t('Cancel')),
        h('button', { class: 'primary', onclick: () => { m.close(); resolve(true); } }, okLabel)),
    );
  });
}

/** In-page text prompt. Resolves to the trimmed text, or null if cancelled. */
function promptDialog(title, placeholder, okLabel = t('OK')) {
  return new Promise((resolve) => {
    const input = h('input', { id: 'prompt-input', placeholder, autocomplete: 'off' });
    const done = (value) => {
      m.close();
      resolve(value);
    };
    const form = h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        if (input.value.trim()) done(input.value.trim());
        else input.focus();
      },
    },
    h('h2', {}, title),
    input,
    h('div', { class: 'modal-actions' },
      h('button', { type: 'button', onclick: () => done(null) }, t('Cancel')),
      h('button', { type: 'submit', class: 'primary' }, okLabel)));
    const m = modal(form);
    input.focus();
  });
}

/** "Oct 29, 2026" / "29 oct 2026" from a SQLite UTC timestamp. */
function fmtDate(sqlite) {
  if (!sqlite) return '';
  return new Date(sqlite.replace(' ', 'T') + 'Z').toLocaleDateString(locale(), { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "today at 3:15 PM", or "Oct 25 at 3:15 PM". */
function fmtWhen(sqlite) {
  const d = new Date(sqlite.replace(' ', 'T') + 'Z');
  const time = d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return t('today at {time}', { time });
  return t('{date} at {time}', { date: d.toLocaleDateString(locale(), { month: 'short', day: 'numeric' }), time });
}

/** "Oct 29, 2026" from YYYY-MM-DD. */
function fmtDue(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale(), { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Copy text, falling back to a selected text box where the clipboard isn't available. */
async function copyText(text, what = t('Copied')) {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    const box = h('textarea', { readonly: true }, text);
    const m = modal(h('h2', {}, t('Copy this')), h('p', { class: 'small muted' }, t('Select all of it and copy.')), box,
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => m.close() }, t('Done'))));
    box.select();
  }
}

/** Save a file the server sends. */
async function downloadFile(url) {
  const res = await fetch(url, { headers: { 'X-Lang': lang } });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || t('Download failed ({status})', { status: res.status }));
  const header = res.headers.get('content-disposition') || '';
  const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(header)?.[1] || '') || /filename="([^"]+)"/.exec(header)?.[1] || 'download';
  const a = h('a', { href: URL.createObjectURL(await res.blob()), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

/** Read a picked image as a data URL, scaled down so it isn't larger than it needs to be. */
function readImage(file, maxSide = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = h('canvas', { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(file.type === 'image/png' && scale === 1 ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error(t('The image must be a PNG or JPEG.')));
    img.src = URL.createObjectURL(file);
  });
}

/** Go to a page on another site (Stripe, the lender). */
const goTo = (url) => {
  location.href = url;
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routes = [
  [/^#\/signin/, viewSignin, 'auth'],
  [/^#\/signup/, viewSignup, 'auth'],
  [/^#\/view\/([\w-]+)(\?.*)?$/, (m) => viewPublicDocument(m[1]), 'public'],
  [/^#\/finance-test\/([\w-]+)\/(\d+)(\?.*)?$/, (m) => viewTestLender(m[1], Number(m[2])), 'public'],
  [/^#\/new\/(quote|invoice)(\?.*)?$/, (m) => viewDocument(null, m[1])],
  [/^#\/doc\/(\d+)$/, (m) => viewDocument(Number(m[1]))],
  [/^#\/?(\?.*)?$/, viewBilling],
];

const hashParams = () => new URLSearchParams(location.hash.split('?')[1] || '');

let cleanup = null;
async function route() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  const hash = location.hash || '#/';
  document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove());
  for (const [pattern, view, access] of routes) {
    const match = hash.match(pattern);
    if (!match) continue;
    if (!access && !state.user) {
      location.hash = '#/signin';
      return;
    }
    renderNav(hash, access);
    $app.replaceChildren(h('p', { class: 'loading' }, t('Loading…')));
    try {
      await view(match);
    } catch (err) {
      $app.replaceChildren(h('div', { class: 'banner error' }, err.message));
    }
    window.scrollTo(0, 0);
    return;
  }
  location.hash = '#/';
}

// ---- Notifications: the bell in the top bar ----
const bell = { count: 0, timer: null };

async function refreshBell() {
  if (!state.user) return;
  try {
    const { unread } = await api('GET', '/api/notifications');
    bell.count = unread;
    const badge = document.querySelector('.bell-count');
    if (badge) {
      badge.textContent = unread > 9 ? '9+' : String(unread);
      badge.hidden = !unread;
    }
  } catch {
    // Checked again in a minute.
  }
}

async function openNotifications() {
  const { items } = await api('GET', '/api/notifications');
  const icon = { lead: '👋', approved: '✅', declined: '✖', paid: '💵', payment_failed: '⚠', financing: '🏦' };
  const m = modal(
    h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, t('Notifications')), h('span', { class: 'spacer' }),
      items.some((n) => !n.read) ? h('button', { class: 'link small', onclick: async () => {
        await api('POST', '/api/notifications/read', {});
        m.close();
        refreshBell();
      } }, t('Mark all as read')) : null),
    items.length ? h('ul', { class: 'notice-list' }, items.map((n) => h('li', { class: n.read ? '' : 'unread' },
      h('a', {
        href: n.link || '#/',
        onclick: async () => {
          m.close();
          if (!n.read) await api('POST', '/api/notifications/read', { ids: [n.id] }).catch(() => {});
          refreshBell();
        },
      }, h('span', { class: 'notice-icon', 'aria-hidden': 'true' }, icon[n.kind] || '•'),
      h('span', { class: 'grow' }, n.text, h('div', { class: 'small muted' }, fmtWhen(n.created_at)))))))
      : h('p', { class: 'empty' }, t('Nothing new yet. New leads, approvals and payments show up here.')),
    h('div', { class: 'modal-actions' }, h('button', { onclick: () => m.close() }, t('Close'))));
}

/** Top bar: the business name (or "‹ Back" on a quote or invoice), the bell and the account menu. */
function renderNav(hash, access) {
  const bar = document.getElementById('topbar');
  bar.hidden = !state.user || Boolean(access);
  if (bar.hidden) return;
  const isHome = !hash.startsWith('#/doc/') && !hash.startsWith('#/new/');
  const initials = state.user.name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const menu = h('div', { class: 'account-menu', role: 'menu', hidden: true },
    h('div', { class: 'who' }, h('strong', {}, state.user.name), h('div', { class: 'small muted' }, state.user.email)),
    h('div', { class: 'menu-lang' }, h('span', { class: 'small muted' }, t('Language')), langSwitch(async (code) => {
      await api('PUT', '/auth/language', { language: code }).catch(() => {});
      state.user.language = code;
    })),
    h('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); passwordDialog(); } }, t('Change password')),
    h('button', {
      type: 'button',
      role: 'menuitem',
      onclick: async () => {
        await api('POST', '/auth/logout').catch(() => {});
        state.user = null;
        clearInterval(bell.timer);
        location.hash = '#/signin';
      },
    }, t('Sign out')));
  const closeMenu = (e) => {
    if (e && e.type === 'click' && (menu.contains(e.target) || account.contains(e.target))) return;
    if (e && e.type === 'keydown' && e.key !== 'Escape') return;
    menu.hidden = true;
    account.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', closeMenu);
    document.removeEventListener('keydown', closeMenu);
  };
  const account = h('button', {
    type: 'button',
    class: 'account',
    'aria-label': t('Account menu for {name}', { name: state.user.name }),
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    onclick: () => {
      if (!menu.hidden) return closeMenu();
      menu.hidden = false;
      account.setAttribute('aria-expanded', 'true');
      setTimeout(() => {
        document.addEventListener('click', closeMenu);
        document.addEventListener('keydown', closeMenu);
      });
    },
  }, initials || '?');
  const bellBtn = h('button', { type: 'button', class: 'bell', 'aria-label': t('Notifications'), onclick: () => openNotifications().catch(showError) },
    h('span', { 'aria-hidden': 'true' }, '🔔'), h('span', { class: 'bell-count', hidden: !bell.count }, bell.count > 9 ? '9+' : String(bell.count)));
  fill(bar,
    isHome ? h('a', { href: '#/', class: 'brand' }, state.companyName || 'ProntoPaid')
      : h('a', { href: billingBack(), class: 'back' }, h('span', { 'aria-hidden': 'true' }, '‹'), ` ${t('Back')}`),
    h('span', { class: 'spacer' }),
    bellBtn,
    account,
    menu);
}

window.addEventListener('hashchange', route);

async function loadSession() {
  const me = await api('GET', '/auth/me');
  state.user = me.user;
  state.business = me.business;
  if (state.user) {
    setLang(state.user.language);
    billingMeta = null;
    state.companyName = (await getBillingMeta()).settings.company_name || me.business.name;
    refreshBell();
    clearInterval(bell.timer);
    bell.timer = setInterval(refreshBell, 60000);
  }
}

(async function init() {
  try {
    await loadSession();
  } catch (err) {
    $app.replaceChildren(h('div', { class: 'banner error' }, err.message));
    return;
  }
  route();
})();

// ---------------------------------------------------------------------------
// Sign up, sign in, password
// ---------------------------------------------------------------------------

const authInput = (name, label, attrs = {}) => h('div', {}, h('label', { for: `a-${name}` }, label), h('input', { id: `a-${name}`, name, required: true, ...attrs }));

function authPage(title, intro, form, footer) {
  fill($app, h('div', { class: 'signin' },
    h('div', { class: 'brand-mark' }, h('span', { class: 'logo-dot', 'aria-hidden': 'true' }, 'P'), 'ProntoPaid'),
    h('p', { class: 'tagline' }, t('Quote. Invoice. Get paid fast.')),
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('h1', { style: 'margin:0' }, title), h('span', { class: 'spacer' }), langSwitch()),
      intro ? h('p', { class: 'muted' }, intro) : null, form),
    footer ? h('p', { class: 'center small' }, footer) : null));
}

function authForm(submitLabel, fields, send) {
  const error = h('div', { class: 'banner error', hidden: true });
  const button = h('button', { type: 'submit', class: 'primary', style: 'width:100%;margin-top:1.25rem' }, submitLabel);
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      button.disabled = true;
      try {
        await send(Object.fromEntries(new FormData(form)));
      } catch (err) {
        error.hidden = false;
        error.textContent = err.message;
      }
      button.disabled = false;
    },
  }, error, fields, button);
  return form;
}

async function viewSignin() {
  if (state.user) return void (location.hash = '#/');
  authPage(t('Sign in'), null, authForm(t('Sign in'), [
    authInput('email', t('Email'), { type: 'email', autocomplete: 'username' }),
    authInput('password', t('Password'), { type: 'password', autocomplete: 'current-password' }),
    h('p', { class: 'small muted' }, t('Forgot your password? Ask your administrator to set a new one on the Team tab.')),
  ], async (body) => {
    await api('POST', '/auth/login', body);
    await loadSession();
    location.hash = '#/';
  }), [t('New to ProntoPaid?'), ' ', h('a', { href: '#/signup' }, t('Create a free account'))]);
  document.getElementById('a-email').focus();
}

async function viewSignup() {
  if (state.user) return void (location.hash = '#/');
  authPage(t('Create your account'), t('Free to start. Your business name goes on every quote and invoice, and you can add your team afterwards.'), authForm(t('Create account'), [
    authInput('company_name', t('Business name'), { autocomplete: 'organization' }),
    authInput('name', t('Your name'), { autocomplete: 'name' }),
    authInput('email', t('Your email'), { type: 'email', autocomplete: 'username' }),
    authInput('password', t('Password'), { type: 'password', autocomplete: 'new-password', minlength: 8 }),
  ], async (body) => {
    await api('POST', '/auth/signup', { ...body, language: lang });
    await loadSession();
    toast(t('Welcome! Add your company details, then make your first quote.'));
    location.hash = '#/?tab=settings';
  }), [t('Already have an account?'), ' ', h('a', { href: '#/signin' }, t('Sign in'))]);
}

function passwordDialog() {
  const form = authForm(t('Change password'), [
    authInput('current', t('Current password'), { type: 'password', autocomplete: 'current-password' }),
    authInput('password', t('New password'), { type: 'password', autocomplete: 'new-password', minlength: 8 }),
  ], async (body) => {
    await api('POST', '/auth/password', body);
    m.close();
    toast(t('Password changed'));
  });
  const m = modal(h('h2', {}, t('Change password')), form, h('div', { class: 'modal-actions' }, h('button', { onclick: () => m.close() }, t('Cancel'))));
}

// ---------------------------------------------------------------------------
// Main page: quotes, invoices, customers, price list, leads, website, get paid, company, team
// ---------------------------------------------------------------------------

let billingMeta = null;
const getBillingMeta = async (fresh = false) => (billingMeta = !fresh && billingMeta ? billingMeta : await api('GET', '/api/meta'));
const TYPE_NAME = { quote: 'Quote', invoice: 'Invoice' };
const STATUS_CLASS = { draft: 'muted', sent: '', viewed: '', approved: 'ok', invoiced: 'ok', paid: 'ok', declined: 'bad', overdue: 'bad', void: 'bad', partial: 'warn', expired: 'warn' };
const statusBadge = (d) => h('span', { class: `badge ${STATUS_CLASS[d.display_status] ?? ''}` }, t(d.status_label));
const fmtCents = (c) => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'USD' }).format((c || 0) / 100);
const centsOf = (v) => {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const dollars = (c) => (c ? (c / 100).toFixed(2) : '');
const localToday = () => new Date().toLocaleDateString('en-CA');
const contactLabel = (c) => (c.company && c.company !== c.name ? `${c.name} · ${c.company}` : c.name);
const LANG_NAME = { en: 'English', es: 'Español' };
const billingTab = () => hashParams().get('tab') || 'quotes';
let lastBillingTab = 'quotes';
const billingBack = () => `#/?tab=${lastBillingTab}`;
const isAdmin = () => state.user.role === 'admin';

/** The same arithmetic as the server (server/billing.js totals()), so the form shows what will be saved. */
function billTotals(d, lines, paid = 0) {
  const amounts = lines.map((l) => Math.round((Number(String(l.quantity).replace(/[,\s]/g, '')) || 0) * centsOf(l.unit_price)));
  const subtotal = amounts.reduce((a, b) => a + b, 0);
  const taxableSubtotal = amounts.reduce((a, amount, i) => a + (lines[i].taxable ? amount : 0), 0);
  const value = Number(String(d.discount_value ?? '').replace(/[$,%\s]/g, '')) || 0;
  let discount = d.discount_type === 'percent' ? Math.round((subtotal * value) / 100) : Math.round(value * 100);
  discount = Math.max(0, Math.min(discount, Math.max(subtotal, 0)));
  const taxableBase = subtotal > 0 ? taxableSubtotal - Math.round((discount * taxableSubtotal) / subtotal) : taxableSubtotal;
  const tax = Math.round((Math.max(taxableBase, 0) * (Number(d.tax_rate) || 0)) / 100);
  const total = subtotal - discount + tax;
  return { amounts, subtotal, discount, tax, total, deposit: d.type === 'quote' ? Math.round((total * (Number(d.deposit_percent) || 0)) / 100) : 0, paid, balance: total - paid };
}

async function viewBilling() {
  const tab = billingTab();
  lastBillingTab = tab;
  const tabs = [['quotes', t('Quotes')], ['invoices', t('Invoices')], ['customers', t('Customers')], ['items', t('Price list')], ['leads', t('Leads')]];
  if (isAdmin()) tabs.push(['site', t('Website')], ['getpaid', t('Get paid')], ['settings', t('Company')], ['team', t('Team')]);
  const [meta, docs] = await Promise.all([getBillingMeta(true), ['quotes', 'invoices'].includes(tab) ? api('GET', '/api/docs') : null]);
  const body = h('div');
  fill($app,
    h('div', { class: 'toolbar' },
      h('h1', { style: 'margin:0' }, t('Quotes & Invoices')),
      meta.plan.premium ? h('span', { class: 'badge premium' }, '★ Premium') : null,
      h('span', { class: 'spacer' }),
      h('a', { class: 'btn', href: '#/new/invoice' }, t('+ Invoice')),
      h('a', { class: 'btn primary', href: '#/new/quote' }, t('+ Quote'))),
    docs ? billingSummary(docs.summary) : null,
    h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([key, label]) =>
      h('a', { href: `#/?tab=${key}`, role: 'tab', class: `tab${tab === key ? ' active' : ''}`, 'aria-selected': String(tab === key) }, label))),
    body);
  if (tab === 'quotes' || tab === 'invoices') documentList(body, tab === 'quotes' ? 'quote' : 'invoice', docs[tab]);
  else if (tab === 'customers') await customerList(body, meta);
  else if (tab === 'items') await itemList(body, meta);
  else if (tab === 'leads') await leadList(body, meta);
  else if (tab === 'site' && isAdmin()) await siteEditor(body, meta);
  else if (tab === 'getpaid' && isAdmin()) await getPaid(body, meta);
  else if (tab === 'settings' && isAdmin()) companySettings(body, meta);
  else if (tab === 'team' && isAdmin()) await teamList(body);
}

function billingSummary(s) {
  const tile = (label, value, note, cls = '', href) => h(href ? 'a' : 'div', { class: `stat ${cls}`, href },
    h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), h('div', { class: 'small muted' }, note));
  return h('div', { class: 'stats' },
    tile(t('Unpaid invoices'), fmtCents(s.unpaid), t('{n} open', { n: s.unpaid_count }), '', '#/?tab=invoices'),
    tile(t('Overdue'), fmtCents(s.overdue), t(s.overdue_count === 1 ? '{n} invoice' : '{n} invoices', { n: s.overdue_count }), s.overdue_count ? 'bad' : '', '#/?tab=invoices'),
    tile(t('Quotes awaiting approval'), fmtCents(s.quotes_pending), t('{n} sent', { n: s.quotes_pending_count }), '', '#/?tab=quotes'),
    tile(t('Approved, not invoiced'), fmtCents(s.approved_to_invoice), t(s.approved_to_invoice_count === 1 ? '{n} quote' : '{n} quotes', { n: s.approved_to_invoice_count }), s.approved_to_invoice_count ? 'ok' : '', '#/?tab=quotes'));
}

function documentList(el, type, rows) {
  const filters = type === 'quote'
    ? [['all', t('All')], ['draft', t('Drafts')], ['waiting', t('Awaiting approval')], ['approved', t('Approved')], ['invoiced', t('Invoiced')], ['declined', t('Declined / expired')]]
    : [['all', t('All')], ['draft', t('Drafts')], ['open', t('Unpaid')], ['overdue', t('Overdue')], ['paid', t('Paid')], ['void', t('Void')]];
  const groups = { waiting: ['sent', 'viewed'], declined: ['declined', 'expired'], open: ['sent', 'viewed', 'partial', 'overdue'] };
  let filter = 'all';
  let q = '';
  const list = h('div');
  const chips = h('div', { class: 'choice-row filter-row' });
  const render = () => {
    const matches = (d) => (filter === 'all' || (groups[filter] || [filter]).includes(d.display_status))
      && (!q || [d.number, d.contact_name, d.contact_company, d.title, d.job_address].join(' ').toLowerCase().includes(q));
    fill(chips, filters.map(([key, label]) => {
      const n = rows.filter((d) => key === 'all' || (groups[key] || [key]).includes(d.display_status)).length;
      return h('button', { type: 'button', class: `chip${filter === key ? ' active' : ''}`, onclick: () => { filter = key; render(); } }, label, key !== 'all' && n ? h('span', { class: 'chip-count' }, n) : null);
    }));
    const shown = rows.filter(matches);
    fill(list, shown.length ? shown.map((d) => h('a', { class: 'card doc-row', href: `#/doc/${d.id}` },
      h('div', { class: 'grow' },
        h('div', { class: 'row', style: 'gap:.5rem' }, h('strong', {}, d.contact_name || t('No customer')), statusBadge(d)),
        h('div', { class: 'small muted' }, [d.number, d.title || d.job_address, fmtDue(d.issue_date)].filter(Boolean).join(' · ')),
        type === 'invoice' && d.due_date && ['sent', 'viewed', 'partial', 'overdue'].includes(d.display_status)
          ? h('div', { class: `small ${d.display_status === 'overdue' ? 'danger' : 'muted'}` }, t('Due {date}', { date: fmtDue(d.due_date) })) : null),
      h('div', { class: 'doc-amount' },
        h('strong', {}, fmtCents(type === 'invoice' && !['draft', 'void'].includes(d.display_status) ? d.balance : d.total)),
        type === 'invoice' && d.paid && d.balance > 0 ? h('div', { class: 'small muted' }, t('of {amount}', { amount: fmtCents(d.total) })) : null)))
      : h('p', { class: 'empty' }, rows.length ? t('Nothing matches.') : t(type === 'quote' ? 'No quotes yet. Tap "+ Quote" to make one.' : 'No invoices yet. Tap "+ Invoice" to make one.')));
  };
  fill(el,
    h('div', { class: 'toolbar' }, h('input', { type: 'search', placeholder: t('Search customer, number or job…'), style: 'max-width:340px', oninput: (e) => { q = e.target.value.toLowerCase(); render(); } })),
    chips,
    list);
  render();
}

// ---- Customers ----

async function customerList(el, meta) {
  const showArchived = location.hash.includes('archived');
  const rows = await api('GET', `/api/contacts${showArchived ? '?archived=1' : ''}`);
  let q = '';
  const list = h('div');
  const render = () => {
    const shown = rows.filter((c) => !q || [c.name, c.company, c.email, c.phone, c.address, c.city].join(' ').toLowerCase().includes(q));
    fill(list, shown.length ? shown.map((c) => h('button', { type: 'button', class: 'card doc-row contact-row', onclick: async () => { if (await contactDialog(c, meta)) route(); } },
      h('div', { class: 'grow' },
        h('div', { class: 'row', style: 'gap:.5rem' }, h('strong', {}, contactLabel(c)), h('span', { class: 'badge muted' }, t(meta.kinds[c.kind] || c.kind)),
          c.language === 'es' ? h('span', { class: 'badge' }, 'ES') : null),
        h('div', { class: 'small muted' }, [c.email, c.phone, [c.address, c.city].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || t('No contact details'))),
      h('span', { class: 'small muted' }, c.document_count ? t(c.document_count === 1 ? '{n} quote/invoice' : '{n} quotes/invoices', { n: c.document_count }) : '')))
      : h('p', { class: 'empty' }, rows.length ? t('Nothing matches.') : showArchived ? t('No archived customers.') : t('No customers yet. Add the clients, property owners, contractors and vendors you quote or bill.')));
  };
  fill(el,
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: t('Search customers…'), style: 'max-width:340px', oninput: (e) => { q = e.target.value.toLowerCase(); render(); } }),
      h('span', { class: 'spacer' }),
      h('a', { class: 'small', href: showArchived ? '#/?tab=customers' : '#/?tab=customers&archived' }, showArchived ? t('Show active') : t('Show archived')),
      h('button', { class: 'primary', onclick: async () => { if (await contactDialog(null, meta)) route(); } }, t('+ New customer'))),
    list);
  render();
}

/** Add or edit a customer. Resolves to the customer's id once saved, or null. */
function contactDialog(c, meta, preset = {}) {
  return new Promise((resolve) => {
    const v = c || { kind: 'client', language: lang, ...preset };
    const field = (name, label, attrs = {}) => h('div', {}, h('label', { for: `c-${name}` }, label), h('input', { id: `c-${name}`, name, value: v[name] || '', ...attrs }));
    const error = h('div', { class: 'banner error', hidden: true });
    const done = (id) => {
      m.close();
      resolve(id);
    };
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(form));
        body.archived = form.archived ? form.archived.checked : false;
        try {
          const res = c ? await api('PUT', `/api/contacts/${c.id}`, body) : await api('POST', '/api/contacts', body);
          toast(t('Customer saved'));
          done(res.id);
        } catch (err) {
          error.hidden = false;
          error.textContent = err.message;
        }
      },
    },
    h('h2', {}, c ? t('Edit customer') : t('New customer')),
    error,
    h('div', { class: 'grid2' }, field('name', t('Name'), { autocomplete: 'off' }), field('company', t('Company'), { placeholder: t('optional') })),
    h('div', { class: 'grid2' },
      h('div', {}, h('label', { for: 'c-kind' }, t('Type')),
        h('select', { id: 'c-kind', name: 'kind' }, Object.entries(meta.kinds).map(([k, label]) => h('option', { value: k, selected: v.kind === k }, t(label))))),
      h('div', {}, h('label', { for: 'c-language' }, t('Language for quotes and invoices')),
        h('select', { id: 'c-language', name: 'language' }, Object.entries(LANG_NAME).map(([k, label]) => h('option', { value: k, selected: v.language === k }, label))))),
    h('div', { class: 'grid2' }, field('phone', t('Phone'), { type: 'tel' }), field('email', t('Email'), { type: 'email' })),
    h('div', { class: 'grid-address' }, field('address', t('Billing address')), field('city', t('City')), field('state', t('State')), field('zip', t('ZIP'))),
    h('div', {}, h('label', { for: 'c-notes' }, t('Notes')), h('textarea', { id: 'c-notes', name: 'notes', value: v.notes || '', style: 'min-height:60px' })),
    c ? h('label', { class: 'check-line' }, h('input', { type: 'checkbox', name: 'archived', checked: Boolean(c.archived) }), t('Archived (hidden from the lists)')) : null,
    h('div', { class: 'modal-actions' },
      c && isAdmin() ? h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (!(await confirmDialog(t('Delete this customer?'), t('{name} will be removed.', { name: c.name }), t('Delete')))) return;
        try {
          await api('DELETE', `/api/contacts/${c.id}`);
          toast(t('Customer deleted'));
          done(c.id);
        } catch (err) {
          error.hidden = false;
          error.textContent = err.message;
        }
      } }, t('Delete')) : null,
      c ? h('a', { class: 'btn', href: `#/new/quote?contact=${c.id}`, onclick: () => m.close() }, t('New quote')) : null,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', onclick: () => done(null) }, t('Cancel')),
      h('button', { type: 'submit', class: 'primary' }, t('Save'))));
    const m = modal(form);
    form.name.focus();
  });
}

// ---- Price list ----

async function itemList(el, meta) {
  const rows = await api('GET', '/api/items');
  let q = '';
  const list = h('div');
  const render = () => {
    const shown = rows.filter((i) => !q || `${i.name} ${i.description}`.toLowerCase().includes(q));
    fill(list, shown.length ? shown.map((i) => h('button', { type: 'button', class: 'card doc-row contact-row', onclick: async () => { if (await itemDialog(i, meta)) route(); } },
      h('div', { class: 'grow' }, h('strong', {}, i.name), i.description ? h('div', { class: 'small muted clamp' }, i.description) : null),
      h('div', { class: 'doc-amount' }, h('strong', {}, fmtCents(i.unit_price)), h('div', { class: 'small muted' }, [i.unit ? t('per {unit}', { unit: t(i.unit) }) : '', i.taxable ? t('taxable') : ''].filter(Boolean).join(' · ')))))
      : h('p', { class: 'empty' }, rows.length ? t('Nothing matches.') : t('No saved items yet. Save the work and materials you charge for often, then add them to a quote in one tap.')));
  };
  fill(el,
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: t('Search items…'), style: 'max-width:340px', oninput: (e) => { q = e.target.value.toLowerCase(); render(); } }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: async () => { if (await itemDialog(null, meta)) route(); } }, t('+ New item'))),
    list);
  render();
}

function itemDialog(item, meta, preset = {}) {
  return new Promise((resolve) => {
    const v = item || { taxable: false, ...preset };
    const error = h('div', { class: 'banner error', hidden: true });
    const done = (ok) => {
      m.close();
      resolve(ok);
    };
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(form));
        body.taxable = form.taxable.checked;
        try {
          if (item) await api('PUT', `/api/items/${item.id}`, body);
          else await api('POST', '/api/items', body);
          toast(t('Saved to the price list'));
          done(true);
        } catch (err) {
          error.hidden = false;
          error.textContent = err.message;
        }
      },
    },
    h('h2', {}, item ? t('Edit item') : t('New price list item')),
    error,
    h('label', { for: 'i-name' }, t('Name')), h('input', { id: 'i-name', name: 'name', value: v.name || '', placeholder: t('e.g. Replace GFCI outlet') }),
    h('label', { for: 'i-description' }, t('Description'), h('span', { class: 'hint' }, ` — ${t('optional; printed under the name')}`)),
    h('textarea', { id: 'i-description', name: 'description', value: v.description || '', style: 'min-height:60px' }),
    h('div', { class: 'grid2' },
      h('div', {}, h('label', { for: 'i-price' }, t('Price')), h('input', { id: 'i-price', name: 'unit_price', inputmode: 'decimal', placeholder: '$', value: typeof v.unit_price === 'number' ? dollars(v.unit_price) : v.unit_price || '' })),
      h('div', {}, h('label', { for: 'i-unit' }, t('Per')), h('input', { id: 'i-unit', name: 'unit', value: v.unit || '', list: 'unit-options', placeholder: t('each, hour, sq ft…') }))),
    h('label', { class: 'check-line' }, h('input', { type: 'checkbox', name: 'taxable', checked: Boolean(v.taxable) }), t('Taxable (materials)')),
    unitOptions(meta),
    h('div', { class: 'modal-actions' },
      item ? h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (!(await confirmDialog(t('Delete this item?'), t('{name} will be removed from the price list. Quotes and invoices that use it keep it.', { name: item.name }), t('Delete')))) return;
        await api('DELETE', `/api/items/${item.id}`).catch(showError);
        done(true);
      } }, t('Delete')) : null,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', onclick: () => done(false) }, t('Cancel')),
      h('button', { type: 'submit', class: 'primary' }, t('Save'))));
    const m = modal(form);
    form.name.focus();
  });
}

const unitOptions = (meta) => h('datalist', { id: 'unit-options' }, meta.units.map((u) => h('option', { value: t(u) })));

// ---- Leads: requests from the landing page ----

const LEAD_STATUS = { new: 'New', contacted: 'Contacted', quoted: 'Quoted', won: 'Won', lost: 'Lost' };
const LEAD_CLASS = { new: '', contacted: 'muted', quoted: 'warn', won: 'ok', lost: 'bad' };

async function leadList(el, meta) {
  const rows = await api('GET', '/api/leads');
  const site = meta.plan.premium ? null : h('div', { class: 'banner' }, t('Leads come from your website. Get a landing page with Premium on the Website tab.'));
  fill(el,
    site,
    rows.length ? rows.map((l) => h('div', { class: `card lead${l.status === 'new' ? ' lead-new' : ''}` },
      h('div', { class: 'row', style: 'gap:.5rem' },
        h('strong', {}, l.name),
        h('span', { class: `badge ${LEAD_CLASS[l.status]}` }, t(LEAD_STATUS[l.status])),
        l.language === 'es' ? h('span', { class: 'badge' }, 'ES') : null,
        h('span', { class: 'spacer' }),
        h('span', { class: 'small muted' }, fmtWhen(l.created_at))),
      l.service ? h('div', {}, h('strong', {}, `${t('Service')}: `), l.service) : null,
      h('div', { class: 'small' },
        l.phone ? h('a', { href: `tel:${l.phone.replace(/[^\d+]/g, '')}` }, `📞 ${l.phone}`) : null, l.phone && l.email ? ' · ' : '',
        l.email ? h('a', { href: `mailto:${l.email}` }, `✉ ${l.email}`) : null),
      l.address ? h('div', { class: 'small muted' }, `📍 ${l.address}`) : null,
      l.message ? h('p', { class: 'pre' }, l.message) : null,
      h('div', { class: 'row', style: 'gap:.5rem' },
        h('select', {
          'aria-label': t('Status'),
          style: 'width:auto',
          onchange: async (e) => {
            try {
              await api('PUT', `/api/leads/${l.id}`, { status: e.target.value });
              toast(t('Saved'));
              route();
            } catch (err) {
              showError(err);
            }
          },
        }, Object.entries(LEAD_STATUS).map(([k, label]) => h('option', { value: k, selected: l.status === k }, t(label)))),
        h('span', { class: 'spacer' }),
        h('button', { class: 'primary small-btn', onclick: async () => {
          try {
            const r = await api('POST', `/api/leads/${l.id}/quote`);
            location.hash = `#/new/quote?contact=${r.contact_id}&job=${encodeURIComponent(r.job_address || '')}&title=${encodeURIComponent(r.title || '')}`;
          } catch (err) {
            showError(err);
          }
        } }, t('Make a quote')))))
      : h('p', { class: 'empty' }, t('No leads yet. When someone fills in the form on your website, they show up here and you get a notification.')));
}

// ---- Website (Premium) ----

async function siteEditor(el, meta) {
  const site = await api('GET', '/api/site');
  const params = hashParams();
  if (params.get('premium') === '1') toast(t('Welcome to Premium! Publish your page when it looks right.'));
  let editLang = 'en';
  const content = { en: { ...site.content.en }, es: { ...site.content.es } };
  const error = h('div', { class: 'banner error', hidden: true });
  const fields = h('div');
  const input = (key, label, attrs = {}) => h('div', {}, h('label', { for: `w-${key}` }, label),
    h(attrs.textarea ? 'textarea' : 'input', { id: `w-${key}`, value: Array.isArray(content[editLang][key]) ? content[editLang][key].join('\n') : content[editLang][key] || '', oninput: (e) => { content[editLang][key] = key === 'services' ? e.target.value.split('\n') : e.target.value; }, ...attrs, textarea: undefined }));
  const renderFields = () => fill(fields,
    h('div', { class: 'choice-row', role: 'tablist', 'aria-label': t('Page language') },
      Object.entries(LANG_NAME).map(([k, label]) => h('button', { type: 'button', class: `chip${editLang === k ? ' active' : ''}`, onclick: () => { editLang = k; renderFields(); } }, label))),
    h('p', { class: 'small muted' }, t('Write your page in both languages. Visitors switch between them at the top of the page; anything left blank shows the other language.')),
    input('headline', t('Headline'), { placeholder: t('e.g. Licensed plumbing in San Bernardino') }),
    input('tagline', t('Short description'), { placeholder: t('e.g. Fast, honest repairs. Free quotes.') }),
    input('services', t('Services'), { textarea: true, placeholder: t('One per line: Water heaters, Drain cleaning…'), style: 'min-height:110px' }),
    input('about', t('About your business'), { textarea: true, style: 'min-height:110px' }),
    input('cta', t('Button text'), { placeholder: t('Get a free quote') }));
  renderFields();
  const v = (k) => site[k] || '';
  const slug = h('input', { id: 'w-slug', value: site.slug, oninput: () => { preview.textContent = `${location.origin}/s/${slug.value.toLowerCase().replace(/[^a-z0-9-]/g, '')}`; } });
  const preview = h('span', { class: 'small muted' }, site.url);
  const photo = h('div', { class: 'site-photo' });
  const showPhoto = (s) => fill(photo, s.photo ? h('img', { src: `/s/${s.slug}/photo?${Date.now()}`, alt: '', onerror: (e) => e.target.remove() }) : h('span', { class: 'small muted' }, t('No photo yet')));
  showPhoto(site);
  const file = h('input', {
    type: 'file', accept: 'image/png,image/jpeg', hidden: true,
    onchange: async () => {
      if (!file.files[0]) return;
      try {
        const s = await api('PUT', '/api/site/photo', { data: await readImage(file.files[0], 2000) });
        showPhoto(s);
        toast(t('Photo saved'));
      } catch (err) {
        showError(err);
      }
      file.value = '';
    },
  });
  const form = h('form', {
    class: 'card',
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      const body = Object.fromEntries(new FormData(form));
      body.slug = slug.value;
      body.content = content;
      body.published = form.published ? form.published.checked : false;
      try {
        await api('PUT', '/api/site', body);
        toast(t('Website saved'));
        route();
      } catch (err) {
        error.hidden = false;
        error.textContent = err.message;
      }
    },
  },
  error,
  h('div', { class: 'grid2' },
    h('div', {}, h('label', { for: 'w-slug' }, t('Web address')), slug, preview),
    h('div', {}, h('label', { for: 'w-color' }, t('Color')), h('input', { id: 'w-color', name: 'color', type: 'color', value: site.color, style: 'width:80px;padding:2px' }))),
  fields,
  h('div', { class: 'grid3' },
    h('div', {}, h('label', { for: 'w-phone' }, t('Phone')), h('input', { id: 'w-phone', name: 'phone', type: 'tel', value: v('phone'), placeholder: meta.settings.company_phone })),
    h('div', {}, h('label', { for: 'w-email' }, t('Email')), h('input', { id: 'w-email', name: 'email', type: 'email', value: v('email'), placeholder: meta.settings.company_email })),
    h('div', {}, h('label', { for: 'w-lang' }, t('Page opens in')), h('select', { id: 'w-lang', name: 'default_language' }, Object.entries(LANG_NAME).map(([k, label]) => h('option', { value: k, selected: site.default_language === k }, label))))),
  h('div', {}, h('label', { for: 'w-area' }, t('Service area')), h('input', { id: 'w-area', name: 'service_area', value: v('service_area'), placeholder: t('e.g. San Bernardino and Riverside counties') })),
  h('label', {}, t('Top photo')),
  h('div', { class: 'logo-row' }, photo, h('div', { class: 'row', style: 'gap:.5rem' },
    h('button', { type: 'button', onclick: () => file.click() }, site.photo ? t('Change photo') : t('Upload photo')),
    site.photo ? h('button', { type: 'button', class: 'link small danger', onclick: async () => { showPhoto(await api('DELETE', '/api/site/photo')); } }, t('Remove')) : null), file),
  site.premium ? h('label', { class: 'check-line' }, h('input', { type: 'checkbox', name: 'published', checked: site.published }), t('Published (anyone can visit the page)')) : null,
  h('div', { class: 'modal-actions' },
    site.premium && site.published ? h('a', { class: 'btn', href: site.url, target: '_blank', rel: 'noopener' }, t('View page')) : null,
    h('button', { type: 'submit', class: 'primary' }, t('Save'))));

  fill(el,
    site.premium ? (site.published ? h('div', { class: 'banner ok' }, t('Your page is live at'), ' ', h('a', { href: site.url, target: '_blank', rel: 'noopener' }, site.url)) : h('div', { class: 'banner' }, t('Your page is not published yet. Tick "Published" and save when it looks right.')))
      : premiumPitch(meta),
    form);
}

function premiumPitch(meta) {
  return h('div', { class: 'card premium-card' },
    h('h2', {}, t('Get more customers with Premium')),
    h('ul', {},
      h('li', {}, t('Your own landing page in English and Spanish, built right here')),
      h('li', {}, t('A "get a free quote" form that sends new leads to the app')),
      h('li', {}, t('A notification and email the moment a lead comes in'))),
    h('p', { class: 'small muted' }, t('You can set up your page now; publishing it needs Premium.')),
    meta.plan.canUpgrade ? h('button', { class: 'primary', onclick: async () => {
      try {
        goTo((await api('POST', '/api/payments/premium/checkout')).url);
      } catch (err) {
        showError(err);
      }
    } }, t('Upgrade to Premium')) : h('p', { class: 'small muted' }, t("Premium isn't set up on this server yet.")));
}

// ---- Get paid: bank connection, online payments and financing (admins) ----

async function getPaid(el, meta) {
  const params = hashParams();
  let p = meta.payments;
  if (params.get('connected') === '1' && p.connected) {
    p = await api('POST', '/api/payments/connect/sync').catch(() => p);
    if (p.ready) toast(t('Your bank is connected. Customers can now pay online.'));
  }
  const f = meta.financing;
  const s = meta.settings;
  const stripeCard = h('div', { class: 'card' },
    h('h2', {}, t('Get paid online')),
    h('p', { class: 'muted' }, t('Customers pay quotes deposits and invoices by card or bank transfer from the link you send them. The money goes to your bank, usually in 2 business days.')),
    !p.available ? h('div', { class: 'banner' }, t("Online payments aren't set up on this server yet."))
      : p.ready ? [
        h('div', { class: 'banner ok' }, '✓ ', t('Your bank is connected through Stripe.'), p.payouts ? '' : ` ${t('Stripe is still checking your details; payouts start once it is done.')}`),
        h('div', { class: 'row', style: 'gap:.5rem' },
          h('button', { onclick: async () => {
            try {
              goTo((await api('POST', '/api/payments/dashboard')).url);
            } catch (err) {
              showError(err);
            }
          } }, t('Payouts and bank details')),
          h('label', { class: 'check-line', style: 'margin:0' }, h('input', {
            type: 'checkbox', checked: s.online_payments,
            onchange: async (e) => {
              try {
                await api('PUT', '/api/settings', { online_payments: e.target.checked });
                toast(t('Saved'));
              } catch (err) {
                showError(err);
              }
            },
          }), t('Let customers pay online'))),
      ] : [
        p.submitted ? h('div', { class: 'banner' }, t('Stripe needs a little more information before you can take payments.')) : null,
        h('button', { class: 'primary', onclick: async (e) => {
          e.target.disabled = true;
          try {
            goTo((await api('POST', '/api/payments/connect')).url);
          } catch (err) {
            e.target.disabled = false;
            showError(err);
          }
        } }, p.connected ? t('Finish connecting your bank') : t('Connect your bank')),
        h('p', { class: 'small muted' }, t('You will add your business and bank details on Stripe, our payments partner. ProntoPaid never sees your bank account number.')),
      ]);

  const merchant = h('input', { id: 'f-merchant', value: f.merchantId, placeholder: 'e.g. 1a2b3c…' });
  const enabled = h('input', { type: 'checkbox', checked: f.enabled });
  const finCard = h('div', { class: 'card' },
    h('h2', {}, t('Customer financing')),
    h('p', { class: 'muted' }, t('Let customers pay over time. Once a quote is approved, or on an unpaid invoice, they can check if they qualify in about a minute without affecting their credit score. If they accept the loan, the lender pays you in full.')),
    h('p', { class: 'small muted' }, t('For jobs from {min} to {max}.', { min: fmtCents(f.min * 100), max: fmtCents(f.max * 100) })),
    !f.provider ? h('div', { class: 'banner' }, t("Financing isn't set up on this server yet."))
      : h('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await api('PUT', '/api/settings/financing', { enabled: enabled.checked, merchant_id: merchant.value });
            toast(t('Saved'));
            route();
          } catch (err) {
            showError(err);
          }
        },
      },
      f.provider === 'test' ? h('div', { class: 'banner' }, t('Test mode: a pretend lender is used so you can try the steps. No real loans are made.')) : [
        f.signupUrl ? h('p', {}, h('a', { href: f.signupUrl, target: '_blank', rel: 'noopener' }, t('Sign up with Wisetack, our financing partner')), ' ', t('to get your merchant ID.')) : null,
        h('label', { for: 'f-merchant' }, t('Wisetack merchant ID')), merchant,
      ],
      h('label', { class: 'check-line' }, enabled, t('Offer financing to my customers')),
      f.enabled && !f.ready ? h('p', { class: 'small danger' }, t('Financing is on but not ready: check the merchant ID.')) : null,
      h('div', { class: 'modal-actions' }, h('button', { type: 'submit', class: 'primary' }, t('Save')))));

  fill(el, stripeCard, finCard);
}

// ---- Company settings (admins) ----

function companySettings(el, meta) {
  const s = meta.settings;
  const input = (name, label, attrs = {}, hint) => h('div', {}, h('label', { for: `s-${name}` }, label, hint ? h('span', { class: 'hint' }, ` ${hint}`) : null), h('input', { id: `s-${name}`, name, value: s[name] ?? '', ...attrs }));
  const area = (name, label, hint) => h('div', {}, h('label', { for: `s-${name}` }, label, hint ? h('span', { class: 'hint' }, ` ${hint}`) : null), h('textarea', { id: `s-${name}`, name, value: s[name] ?? '' }));
  const error = h('div', { class: 'banner error', hidden: true });
  const form = h('form', {
    class: 'card',
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      try {
        await api('PUT', '/api/settings', Object.fromEntries(new FormData(form)));
        state.companyName = (await getBillingMeta(true)).settings.company_name;
        renderNav(location.hash);
        toast(t('Company details saved'));
      } catch (err) {
        error.hidden = false;
        error.textContent = err.message;
      }
    },
  },
  h('p', { class: 'small muted' }, t('Printed at the top of every quote and invoice.')),
  error,
  logoPicker(meta),
  h('div', { class: 'grid2' }, input('company_name', t('Company name'), { required: true }), input('license_number', t('License #'), { placeholder: t('optional') })),
  input('company_address', t('Address'), { placeholder: '123 Main St, San Bernardino, CA 92401' }),
  h('div', { class: 'grid3' }, input('company_phone', t('Phone'), { type: 'tel' }), input('company_email', t('Email'), { type: 'email' }), input('company_website', t('Website'))),
  h('h2', { style: 'margin-top:1.25rem' }, t('Defaults')),
  h('div', { class: 'grid3' },
    input('tax_rate', t('Sales tax %'), { inputmode: 'decimal' }, `— ${t('on taxable items')}`),
    input('quote_valid_days', t('Quotes valid for (days)'), { inputmode: 'numeric' }),
    input('invoice_due_days', t('Invoices due in (days)'), { inputmode: 'numeric' }),
    input('deposit_percent', t('Deposit on quotes %'), { inputmode: 'decimal' }, `— ${t('0 for none')}`),
    input('quote_prefix', t('Quote number prefix')),
    input('next_quote_number', t('Next quote number'), { inputmode: 'numeric' }),
    input('invoice_prefix', t('Invoice number prefix')),
    input('next_invoice_number', t('Next invoice number'), { inputmode: 'numeric' })),
  h('h2', { style: 'margin-top:1.25rem' }, t('Terms, in each language')),
  h('p', { class: 'small muted' }, t("Each customer gets the version in their language. Leave the Spanish blank to use the English.")),
  h('div', { class: 'grid2' }, area('quote_terms', t('Quote terms (English)')), area('quote_terms_es', t('Quote terms (Spanish)'))),
  h('div', { class: 'grid2' }, area('invoice_terms', t('Invoice terms (English)')), area('invoice_terms_es', t('Invoice terms (Spanish)'))),
  h('div', { class: 'grid2' },
    area('payment_instructions', t('How to pay (English)'), `— ${t('checks payable to…, Zelle, ACH details')}`),
    area('payment_instructions_es', t('How to pay (Spanish)'))),
  h('div', { class: 'modal-actions' }, h('button', { type: 'submit', class: 'primary' }, t('Save'))));
  fill(el,
    meta.plan.premium && meta.plan.managed ? h('div', { class: 'banner ok' }, '★ ', t('Premium is active.'), ' ', h('button', { class: 'link', onclick: async () => {
      try {
        goTo((await api('POST', '/api/payments/premium/portal')).url);
      } catch (err) {
        showError(err);
      }
    } }, t('Manage subscription'))) : null,
    form);
}

/** Upload or remove the logo printed on quotes and invoices (Company tab). */
function logoPicker(meta) {
  const preview = h('div', { class: 'logo-preview' });
  const show = (has) => fill(preview, has ? h('img', { src: `/api/logo?${Date.now()}`, alt: t('Logo') }) : h('span', { class: 'small muted' }, t('No logo yet')));
  show(meta.logo);
  const file = h('input', {
    type: 'file',
    accept: 'image/png,image/jpeg',
    hidden: true,
    onchange: async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        await api('PUT', '/api/settings/logo', { data: await readImage(f, 800) });
        meta.logo = true;
        show(true);
        toast(t('Logo saved'));
      } catch (err) {
        showError(err);
      }
      file.value = '';
    },
  });
  return h('div', { class: 'logo-row' },
    preview,
    h('div', {},
      h('div', { class: 'row', style: 'gap:.5rem' },
        h('button', { type: 'button', onclick: () => file.click() }, meta.logo ? t('Change logo') : t('Upload logo')),
        h('button', { type: 'button', class: 'link small danger', onclick: async () => {
          await api('DELETE', '/api/settings/logo').catch(showError);
          meta.logo = false;
          show(false);
        } }, t('Remove'))),
      h('p', { class: 'small muted', style: 'margin:.3rem 0 0' }, t('PNG or JPEG. Without one, the company name is printed instead.'))),
    file);
}

// ---- Team (admins) ----

async function teamList(el) {
  const users = await api('GET', '/api/team');
  fill(el,
    h('div', { class: 'toolbar' },
      h('p', { class: 'small muted', style: 'margin:0' }, t("Members see the quotes and invoices they make. Administrators see everyone's and manage the company details, website, payments and team.")),
      h('span', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: async () => { if (await userDialog(null)) route(); } }, t('+ Add person'))),
    users.map((u) => h('button', { type: 'button', class: 'card doc-row contact-row', onclick: async () => { if (await userDialog(u)) route(); } },
      h('div', { class: 'grow' },
        h('div', { class: 'row', style: 'gap:.5rem' }, h('strong', {}, u.name), h('span', { class: `badge ${u.role === 'admin' ? '' : 'muted'}` }, u.role === 'admin' ? t('Administrator') : t('Member')), u.active ? null : h('span', { class: 'badge bad' }, t('Turned off'))),
        h('div', { class: 'small muted' }, u.email, ' · ', u.last_sign_in_at ? t('last signed in {date}', { date: fmtDate(u.last_sign_in_at) }) : t('not signed in yet'))))));
}

function userDialog(u) {
  return new Promise((resolve) => {
    const error = h('div', { class: 'banner error', hidden: true });
    const done = (ok) => {
      m.close();
      resolve(ok);
    };
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(form));
        if (u) body.active = form.active.checked;
        try {
          if (u) await api('PUT', `/api/team/${u.id}`, body);
          else await api('POST', '/api/team', body);
          toast(u ? t('Saved') : t('{name} added. Give them their email and password to sign in.', { name: body.name }));
          done(true);
        } catch (err) {
          error.hidden = false;
          error.textContent = err.message;
        }
      },
    },
    h('h2', {}, u ? t('Edit {name}', { name: u.name }) : t('Add a person')),
    error,
    h('div', { class: 'grid2' },
      h('div', {}, h('label', { for: 'u-name' }, t('Name')), h('input', { id: 'u-name', name: 'name', value: u?.name || '', required: true })),
      h('div', {}, h('label', { for: 'u-email' }, t('Email')), h('input', { id: 'u-email', name: 'email', type: 'email', value: u?.email || '', required: true }))),
    h('div', { class: 'grid2' },
      h('div', {}, h('label', { for: 'u-role' }, t('Role')), h('select', { id: 'u-role', name: 'role' },
        h('option', { value: 'member', selected: u?.role !== 'admin' }, t('Member')), h('option', { value: 'admin', selected: u?.role === 'admin' }, t('Administrator')))),
      h('div', {}, h('label', { for: 'u-password' }, u ? t('New password') : t('Password'), h('span', { class: 'hint' }, u ? ` — ${t('blank to keep theirs')}` : ` — ${t('8+ characters')}`)),
        h('input', { id: 'u-password', name: 'password', type: 'text', autocomplete: 'off', required: !u, minlength: 8 }))),
    u ? null : h('div', {}, h('label', { for: 'u-language' }, t('Language')), h('select', { id: 'u-language', name: 'language' }, Object.entries(LANG_NAME).map(([k, label]) => h('option', { value: k, selected: lang === k }, label)))),
    u ? h('label', { class: 'check-line' }, h('input', { type: 'checkbox', name: 'active', checked: Boolean(u.active) }), t('Can sign in')) : null,
    h('div', { class: 'modal-actions' },
      h('button', { type: 'button', onclick: () => done(false) }, t('Cancel')),
      h('button', { type: 'submit', class: 'primary' }, t('Save'))));
    const m = modal(form);
  });
}

// ---------------------------------------------------------------------------
// One quote or invoice: edit, send, get paid
// ---------------------------------------------------------------------------

async function viewDocument(id, newType) {
  const params = hashParams();
  const [meta, detail, contacts] = await Promise.all([getBillingMeta(), id ? api('GET', `/api/docs/${id}`) : null, api('GET', '/api/contacts')]);
  const s = meta.settings;
  const type = detail ? detail.doc.type : newType;
  if (!id) lastBillingTab = `${type}s`;
  const d = detail ? { ...detail.doc } : {
    type, issue_date: localToday(), due_date: new Date(Date.now() + s[type === 'quote' ? 'quote_valid_days' : 'invoice_due_days'] * 864e5).toLocaleDateString('en-CA'), discount_type: 'amount', discount_value: 0, tax_rate: s.tax_rate,
    deposit_percent: type === 'quote' ? s.deposit_percent : 0, notes: '', title: params.get('title') || '', job_address: params.get('job') || '',
    contact_id: Number(params.get('contact')) || null,
  };
  // Terms come in the customer's language; a new quote picks them when the customer is chosen.
  const termsFor = (contactId) => {
    const c = contacts.find((x) => x.id === contactId);
    return (c && c.language === 'es' && s[`${type}_terms_es`]) || s[`${type}_terms`];
  };
  if (!detail) d.terms = termsFor(d.contact_id);
  // A customer that's archived still shows on the quotes and invoices that use it.
  if (detail?.contact && !contacts.some((c) => c.id === detail.contact.id)) contacts.push(detail.contact);
  const lines = (detail ? detail.lines : []).map((l) => ({ ...l, unit_price: dollars(l.unit_price) || '0.00', quantity: String(l.quantity) }));
  if (!lines.length) lines.push(blankLine());
  const payments = detail ? detail.payments : [];
  const paid = payments.reduce((a, p) => a + p.amount, 0);
  let dirty = !id;
  let termsTouched = Boolean(detail);

  const touch = () => {
    dirty = true;
    saveBtn.disabled = false;
    updateTotals();
  };
  const val = (k) => (d[k] === null || d[k] === undefined ? '' : d[k]);
  const field = (name, label, attrs = {}) => h('div', {}, h('label', { for: `d-${name}` }, label),
    h('input', { id: `d-${name}`, name, value: val(name), oninput: (e) => { d[name] = e.target.value; touch(); }, ...attrs }));

  const termsBox = h('textarea', { id: 'd-terms', value: d.terms, oninput: (e) => { d.terms = e.target.value; termsTouched = true; touch(); } });
  const contactSelect = h('select', {
    id: 'd-contact',
    onchange: (e) => {
      d.contact_id = Number(e.target.value) || null;
      if (!termsTouched) {
        d.terms = termsFor(d.contact_id);
        termsBox.value = d.terms;
      }
      touch();
      renderContactNote();
    },
  });
  const renderContacts = () => {
    contactSelect.replaceChildren(h('option', { value: '' }, t('— Choose a customer —')),
      ...contacts.map((c) => h('option', { value: c.id, selected: c.id === d.contact_id }, contactLabel(c))));
  };
  renderContacts();
  const contactNote = h('div', { class: 'small muted contact-note' });
  const renderContactNote = () => {
    const c = contacts.find((x) => x.id === d.contact_id);
    fill(contactNote, c ? [c.email || t('No email on file'), c.phone ? ` · ${c.phone}` : '', ` · ${LANG_NAME[c.language] || 'English'} · `, h('button', { type: 'button', class: 'link', onclick: async () => {
      if (await contactDialog(c, meta)) await reloadContacts();
    } }, t('Edit'))] : null);
  };
  const reloadContacts = async (select) => {
    const fresh = await api('GET', '/api/contacts');
    contacts.splice(0, contacts.length, ...fresh);
    if (select) d.contact_id = select;
    renderContacts();
    renderContactNote();
  };
  renderContactNote();

  // ---- Line items ----
  const linesEl = h('div', { class: 'lines' });
  function blankLine() {
    return { name: '', description: '', quantity: '1', unit: '', unit_price: '', taxable: false };
  }
  const renderLines = () => {
    fill(linesEl, lines.map((l, i) => {
      const amount = h('strong', { class: 'line-amount' });
      const set = (k) => (e) => {
        l[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
        touch();
      };
      const move = (to) => {
        lines.splice(to, 0, lines.splice(i, 1)[0]);
        touch();
        renderLines();
      };
      const row = h('div', { class: 'line' },
        h('div', { class: 'line-main' },
          h('input', { class: 'line-name', placeholder: t('Item or service'), value: l.name, oninput: set('name'), 'aria-label': t('Line {n} name', { n: i + 1 }) }),
          h('textarea', { class: 'line-desc', placeholder: t('Description (optional)'), value: l.description, oninput: set('description'), rows: 1, 'aria-label': t('Line {n} description', { n: i + 1 }) })),
        h('div', { class: 'line-nums' },
          h('label', { class: 'mini' }, t('Qty'), h('input', { inputmode: 'decimal', value: l.quantity, oninput: set('quantity') })),
          h('label', { class: 'mini' }, t('Per'), h('input', { value: l.unit, list: 'unit-options', placeholder: t('each'), oninput: set('unit') })),
          h('label', { class: 'mini' }, t('Price'), h('input', { inputmode: 'decimal', placeholder: '$', value: l.unit_price, oninput: set('unit_price') })),
          h('div', { class: 'mini' }, t('Amount'), amount)),
        h('div', { class: 'line-tools' },
          h('label', { class: 'check-line small' }, h('input', { type: 'checkbox', checked: Boolean(l.taxable), onchange: set('taxable') }), t('Taxable')),
          h('span', { class: 'spacer' }),
          h('button', { type: 'button', class: 'link small', onclick: async () => {
            if (!l.name.trim()) return toast(t('Give the item a name first.'), true);
            await itemDialog(null, meta, { name: l.name, description: l.description, unit: l.unit, unit_price: l.unit_price, taxable: l.taxable });
          } }, t('Save to price list')),
          h('button', { type: 'button', class: 'icon-btn', title: t('Move up'), 'aria-label': t('Move up'), disabled: i === 0, onclick: () => move(i - 1) }, '↑'),
          h('button', { type: 'button', class: 'icon-btn', title: t('Move down'), 'aria-label': t('Move down'), disabled: i === lines.length - 1, onclick: () => move(i + 1) }, '↓'),
          h('button', { type: 'button', class: 'icon-btn danger', title: t('Remove'), 'aria-label': t('Remove line'), onclick: () => {
            lines.splice(i, 1);
            if (!lines.length) lines.push(blankLine());
            touch();
            renderLines();
          } }, '✕')));
      row.amountEl = amount;
      return row;
    }));
    updateTotals();
  };
  const addLines = (added) => {
    // Replace the empty starter row rather than leaving it above the new ones.
    if (lines.length === 1 && !lines[0].name && !lines[0].unit_price) lines.pop();
    lines.push(...added);
    touch();
    renderLines();
  };

  // ---- Totals ----
  const totalsEl = h('div', { class: 'totals' });
  const discountType = h('select', { 'aria-label': t('Discount type'), onchange: (e) => { d.discount_type = e.target.value; touch(); } },
    h('option', { value: 'amount', selected: d.discount_type === 'amount' }, '$'), h('option', { value: 'percent', selected: d.discount_type === 'percent' }, '%'));
  const totalRow = (label, value, cls = '') => h('div', { class: `total-row ${cls}` }, h('span', {}, label), h('span', {}, value));
  function updateTotals() {
    const tt = billTotals(d, lines, paid);
    [...linesEl.children].forEach((row, i) => { if (row.amountEl) row.amountEl.textContent = fmtCents(tt.amounts[i]); });
    fill(totalsEl,
      totalRow(t('Subtotal'), fmtCents(tt.subtotal)),
      tt.discount ? totalRow(t('Discount'), `-${fmtCents(tt.discount)}`) : null,
      tt.tax || Number(d.tax_rate) ? totalRow(t('Tax ({pct}%)', { pct: Number(d.tax_rate) || 0 }), fmtCents(tt.tax)) : null,
      totalRow(t('Total'), fmtCents(tt.total), 'grand'),
      type === 'quote' && tt.deposit ? totalRow(t('Deposit on approval ({pct}%)', { pct: d.deposit_percent }), fmtCents(tt.deposit)) : null,
      type === 'quote' && paid ? totalRow(t('Paid'), `-${fmtCents(paid)}`) : null,
      type === 'invoice' && paid ? [totalRow(t('Paid'), `-${fmtCents(paid)}`), totalRow(t('Balance due'), fmtCents(tt.balance), 'grand')] : null);
  }

  // ---- Save ----
  const error = h('div', { class: 'banner error', hidden: true });
  const saveBtn = h('button', { type: 'submit', class: 'primary', disabled: !dirty }, id ? t('Save changes') : t(type === 'quote' ? 'Save quote' : 'Save invoice'));
  const body = () => ({ ...d, lines: lines.map((l) => ({ ...l })) });
  async function save() {
    error.hidden = true;
    try {
      if (id) {
        await api('PUT', `/api/docs/${id}`, body());
        dirty = false;
        saveBtn.disabled = true;
        return id;
      }
      const created = await api('POST', '/api/docs', body());
      dirty = false;
      return created.id;
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message;
      error.scrollIntoView({ block: 'center' });
      return null;
    }
  }
  // Anything that uses the saved copy (PDF, send, convert) saves first.
  const saved = async () => (dirty ? save() : id);

  const form = h('form', {
    class: 'doc-form',
    onsubmit: async (e) => {
      e.preventDefault();
      const savedId = await save();
      if (!savedId) return;
      toast(t(type === 'quote' ? 'Quote saved' : 'Invoice saved'));
      if (!id) location.hash = `#/doc/${savedId}`;
      else route();
    },
  },
  error,
  h('div', { class: 'card' },
    h('div', { class: 'grid2' },
      h('div', {}, h('label', { for: 'd-contact' }, type === 'quote' ? t('Customer') : t('Bill to')),
        h('div', { class: 'row', style: 'flex-wrap:nowrap;gap:.5rem' }, contactSelect,
          h('button', { type: 'button', title: t('New customer'), onclick: async () => {
            const newId = await contactDialog(null, meta);
            if (newId) {
              await reloadContacts(newId);
              if (!termsTouched) {
                d.terms = termsFor(newId);
                termsBox.value = d.terms;
              }
              touch();
            }
          } }, t('+ New'))),
        contactNote),
      field('job_address', t('Job site address'))),
    field('title', t('Job title'), { placeholder: type === 'quote' ? t('e.g. Bathroom remodel') : t('e.g. Turnover cleaning, Unit 2B') }),
    h('div', { class: 'grid2' },
      field('issue_date', t('Date'), { type: 'date' }),
      field('due_date', type === 'quote' ? t('Valid until') : t('Payment due'), { type: 'date' }))),
  h('div', { class: 'card' },
    h('h2', {}, t('Items')),
    linesEl,
    unitOptions(meta),
    h('div', { class: 'row', style: 'gap:.5rem;margin-top:.75rem' },
      h('button', { type: 'button', onclick: () => addLines([blankLine()]) }, t('+ Add item')),
      h('button', { type: 'button', onclick: () => catalogPicker(addLines) }, t('+ From price list'))),
    h('div', { class: 'totals-wrap' },
      h('div', { class: 'adjust' },
        h('div', {}, h('label', {}, t('Discount')), h('div', { class: 'row', style: 'flex-wrap:nowrap;gap:.4rem' }, discountType,
          h('input', { inputmode: 'decimal', value: d.discount_value || '', placeholder: '0', 'aria-label': t('Discount'), oninput: (e) => { d.discount_value = e.target.value; touch(); } }))),
        field('tax_rate', t('Tax %'), { inputmode: 'decimal' }),
        type === 'quote' ? field('deposit_percent', t('Deposit %'), { inputmode: 'decimal' }) : null),
      totalsEl)),
  h('div', { class: 'card' },
    h('label', { for: 'd-notes', style: 'margin-top:0' }, t('Notes'), h('span', { class: 'hint' }, ` — ${t('shown to the customer')}`)),
    h('textarea', { id: 'd-notes', value: d.notes, oninput: (e) => { d.notes = e.target.value; touch(); } }),
    h('label', { for: 'd-terms' }, t('Terms')),
    termsBox),
  h('div', { class: 'submit-bar' }, h('a', { class: 'btn', href: billingBack() }, id ? t('Back') : t('Cancel')), saveBtn));
  renderLines();

  cleanup = () => {
    window.onbeforeunload = null;
  };
  window.onbeforeunload = () => (dirty && id ? true : undefined);

  fill($app,
    h('div', { class: 'toolbar doc-head' },
      h('h1', { style: 'margin:0' }, id ? `${t(TYPE_NAME[type])} ${detail.doc.number}` : t(type === 'quote' ? 'New quote' : 'New invoice')),
      id ? statusBadge(detail.doc) : null,
      h('span', { class: 'spacer' }),
      id ? h('strong', { class: 'doc-head-amount' }, fmtCents(type === 'invoice' && !['draft', 'void'].includes(detail.doc.display_status) ? detail.totals.balance : detail.totals.total)) : null),
    id ? documentActions(detail, meta, saved) : null,
    id ? documentTimeline(detail) : null,
    id ? moneyCard(detail, meta, saved) : null,
    form);
}

function documentTimeline(detail) {
  const { doc } = detail;
  const items = [
    [doc.created_by_name ? t('Created {date} by {name}', { date: fmtDate(doc.created_at), name: doc.created_by_name }) : t('Created {date}', { date: fmtDate(doc.created_at) })],
    doc.quote_id ? [t('Made from quote'), ' ', h('a', { href: `#/doc/${doc.quote_id}` }, doc.quote_number)] : null,
    doc.sent_at ? [doc.sent_to ? t('Sent {when} to {to}', { when: fmtWhen(doc.sent_at), to: doc.sent_to }) : t('Sent {when}', { when: fmtWhen(doc.sent_at) })] : null,
    doc.viewed_at ? [t('Opened by the customer {when}', { when: fmtWhen(doc.viewed_at) })] : null,
    doc.approved_at ? [h('strong', { class: 'good' }, t('Approved by {name}', { name: doc.approved_name })), ` ${fmtWhen(doc.approved_at)}`] : null,
    doc.declined_at ? [h('strong', { class: 'danger' }, t('Declined')), ` ${fmtWhen(doc.declined_at)}${doc.decline_reason ? `: "${doc.decline_reason}"` : ''}`] : null,
    doc.invoice_id ? [t('Invoiced on'), ' ', h('a', { href: `#/doc/${doc.invoice_id}` }, doc.invoice_number)] : null,
  ].filter(Boolean);
  return h('ul', { class: 'timeline small muted' }, items.map((parts) => h('li', {}, parts)));
}

function documentActions(detail, meta, saved) {
  const { doc } = detail;
  const id = doc.id;
  const isQuote = doc.type === 'quote';
  const act = async (fn) => {
    try {
      if (!(await saved())) return;
      await fn();
    } catch (err) {
      showError(err);
    }
  };
  const status = (s, name) => act(async () => {
    await api('POST', `/api/docs/${id}/status`, { status: s, name });
    route();
  });
  const pdfUrl = (l = doc.language) => `/api/docs/${id}/pdf?lang=${l}`;
  return h('div', { class: 'doc-actions' },
    h('button', { class: 'primary', onclick: () => act(() => sendDialog(detail, meta)) }, doc.sent_at ? t('Send again') : t('Send')),
    h('a', { class: 'btn', href: pdfUrl(), target: '_blank', onclick: async (e) => {
      e.preventDefault();
      act(async () => window.open(pdfUrl(), '_blank') || downloadFile(`${pdfUrl()}&download=1`));
    } }, t('View PDF')),
    h('button', { onclick: () => act(() => downloadFile(`${pdfUrl()}&download=1`)) }, t('Download')),
    h('button', { onclick: () => act(async () => {
      await copyText(`${detail.public_url}?lang=${doc.language}`, t('Link copied. Paste it into a text or email to the customer.'));
      if (doc.status === 'draft') {
        await api('POST', `/api/docs/${id}/mark-sent`, {});
        route();
      }
    }) }, t('Copy customer link')),
    isQuote && !doc.invoice_id && doc.status !== 'declined' ? h('button', { onclick: () => act(async () => {
      const res = await api('POST', `/api/docs/${id}/convert`);
      toast(res.existing ? t('This quote was already invoiced.') : t('Invoice made from the quote. Check it and send it.'));
      location.hash = `#/doc/${res.id}`;
    }) }, t('Make invoice')) : null,
    !isQuote && doc.display_status !== 'void' && detail.totals.balance > 0 ? h('button', { onclick: () => act(() => paymentDialog(detail, meta)) }, t('Record payment')) : null,
    h('details', { class: 'more' },
      h('summary', { class: 'btn' }, t('More')),
      h('div', { class: 'more-menu' },
        h('button', { onclick: () => act(async () => window.open(pdfUrl(doc.language === 'es' ? 'en' : 'es'), '_blank') || downloadFile(`${pdfUrl(doc.language === 'es' ? 'en' : 'es')}&download=1`)) },
          t('PDF in {language}', { language: LANG_NAME[doc.language === 'es' ? 'en' : 'es'] })),
        isQuote && !['approved', 'invoiced'].includes(doc.display_status) ? h('button', { onclick: async () => {
          const name = await promptDialog(t('Who approved it?'), t('Name (e.g. approved by phone)'), t('Mark approved'));
          if (name) status('approved', name);
        } }, t('Mark approved')) : null,
        isQuote && doc.status !== 'declined' && !doc.invoice_id ? h('button', { onclick: () => status('declined') }, t('Mark declined')) : null,
        doc.status === 'draft' ? h('button', { onclick: () => act(async () => { await api('POST', `/api/docs/${id}/mark-sent`, {}); route(); }) }, t('Mark sent (sent another way)')) : null,
        doc.status !== 'draft' && !doc.invoice_id ? h('button', { onclick: () => status('draft') }, t('Back to draft')) : null,
        !isQuote && doc.status !== 'void' ? h('button', { onclick: async () => {
          if (await confirmDialog(t('Void this invoice?'), t('It stays in the list marked Void and no longer counts as money owed.'), t('Void'))) status('void');
        } }, t('Void')) : null,
        !isQuote && doc.status === 'void' ? h('button', { onclick: () => status('sent') }, t('Un-void')) : null,
        h('button', { onclick: () => act(async () => {
          const res = await api('POST', `/api/docs/${id}/duplicate`);
          toast(t('Copied to a new draft'));
          location.hash = `#/doc/${res.id}`;
        }) }, t('Duplicate')),
        h('button', { class: 'danger', onclick: async () => {
          if (!(await confirmDialog(t('Delete {what} {number}?', { what: t(TYPE_NAME[doc.type]).toLowerCase(), number: doc.number }), t(detail.payments.length ? "It's removed for good, with its payments. The customer's link stops working." : "It's removed for good. The customer's link stops working."), t('Delete')))) return;
          try {
            await api('DELETE', `/api/docs/${id}`);
            toast(t('Deleted'));
            location.hash = billingBack();
          } catch (err) {
            showError(err);
          }
        } }, t('Delete')))));
}

function sendDialog(detail, meta) {
  const { doc, contact } = detail;
  if (!meta.mail) {
    const m = modal(
      h('h2', {}, t('Send it yourself')),
      h('p', {}, t("Email isn't set up in this app yet. Copy the link (the customer can view, approve and pay there) and text or email it, or download the PDF and attach it.")),
      h('div', { class: 'modal-actions' },
        h('button', { onclick: () => m.close() }, t('Close')),
        h('button', { onclick: () => downloadFile(`/api/docs/${doc.id}/pdf?lang=${doc.language}&download=1`).catch(showError) }, t('Download PDF')),
        h('button', { class: 'primary', onclick: async () => {
          await copyText(`${detail.public_url}?lang=${doc.language}`, t('Link copied'));
          await api('POST', `/api/docs/${doc.id}/mark-sent`, {}).catch(showError);
          m.close();
          route();
        } }, t('Copy link'))));
    return;
  }
  const settings = meta.settings;
  let sendLang = doc.language;
  const to = h('input', { id: 'send-to', type: 'email', multiple: true, value: doc.sent_to || contact?.email || '', placeholder: 'name@example.com' });
  const cc = h('input', { id: 'send-cc', type: 'email', multiple: true, placeholder: t('optional') });
  const message = h('textarea', { id: 'send-message' });
  const writeMessage = () => {
    const tl = (text, params) => I18N.tr(sendLang, text, params);
    const greeting = contact ? tl('Hi {name},', { name: contact.name.split(/\s+/)[0] }) : tl('Hello,');
    const signoff = `${tl('Thank you,')}\n${state.user.name}${settings.company_name ? `\n${settings.company_name}` : ''}`;
    message.value = doc.type === 'quote'
      ? `${greeting}\n\n${doc.title ? tl('Here is our quote for {title}. You can review and approve it online with the button below.', { title: doc.title }) : tl('Here is our quote. You can review and approve it online with the button below.')}\n\n${signoff}`
      : `${greeting}\n\n${doc.title ? tl('Here is your invoice for {title}. Please let us know if you have any questions.', { title: doc.title }) : tl('Here is your invoice. Please let us know if you have any questions.')}\n\n${signoff}`;
  };
  writeMessage();
  const langSelect = h('select', { id: 'send-lang', onchange: (e) => { sendLang = e.target.value; writeMessage(); } },
    Object.entries(LANG_NAME).map(([k, label]) => h('option', { value: k, selected: sendLang === k }, label)));
  const error = h('div', { class: 'banner error', hidden: true });
  const sendBtn = h('button', { type: 'submit', class: 'primary' }, t('Send email'));
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      sendBtn.disabled = true;
      sendBtn.textContent = t('Sending…');
      error.hidden = true;
      try {
        await api('POST', `/api/docs/${doc.id}/send`, { to: to.value, cc: cc.value, message: message.value, language: sendLang });
        m.close();
        toast(t(doc.type === 'quote' ? 'Quote emailed' : 'Invoice emailed'));
        route();
      } catch (err) {
        error.hidden = false;
        error.textContent = err.message;
        sendBtn.disabled = false;
        sendBtn.textContent = t('Send email');
      }
    },
  },
  h('h2', {}, t('Email {what} {number}', { what: t(TYPE_NAME[doc.type]).toLowerCase(), number: doc.number })),
  error,
  h('label', { for: 'send-to' }, t('To')), to,
  h('label', { for: 'send-cc' }, t('CC')), cc,
  h('label', { for: 'send-lang' }, t('Language of the email and PDF')), langSelect,
  h('label', { for: 'send-message' }, t('Message')), message,
  h('p', { class: 'small muted' }, t(doc.type === 'quote' ? 'The PDF is attached, with a button to view and approve the quote online.' : 'The PDF is attached, with a button to view and pay the invoice online.')),
  h('div', { class: 'modal-actions' }, h('button', { type: 'button', onclick: () => m.close() }, t('Cancel')), sendBtn));
  const m = modal(form);
  to.focus();
}

/** Payments, money on its way, online payment and financing status for one quote or invoice. */
function moneyCard(detail, meta, saved) {
  const { doc, payments, totals, pending_payments: pending, online, financing } = detail;
  const app = financing.application;
  const rows = [];
  if (payments.length) {
    rows.push(h('h2', {}, t('Payments')),
      h('ul', { class: 'payment-list' }, payments.map((p) => h('li', {},
        h('span', { class: 'grow' }, h('strong', {}, fmtCents(p.amount)), ` · ${fmtDue(p.paid_on)}`, p.method ? ` · ${t(p.method)}` : '', p.reference ? h('span', { class: 'muted' }, ` (${p.reference})`) : null,
          p.document_id !== doc.id ? h('span', { class: 'muted' }, ` · ${t('paid on the quote')}`) : null),
        p.source === 'manual' && p.document_id === doc.id ? h('button', { class: 'link small danger', onclick: async () => {
          if (!(await confirmDialog(t('Remove this payment?'), t('{amount} on {date} will be removed.', { amount: fmtCents(p.amount), date: fmtDue(p.paid_on) }), t('Remove')))) return;
          await api('DELETE', `/api/docs/${doc.id}/payments/${p.id}`).catch(showError);
          route();
        } }, t('Remove')) : null))));
  }
  if (pending.length) rows.push(h('div', { class: 'banner' }, t('{amount} paid by bank transfer is on its way. Bank payments take a few business days to clear.', { amount: fmtCents(pending.reduce((a, p) => a + p.amount, 0)) })));
  if (doc.type === 'invoice' && payments.length) {
    rows.push(h('div', { class: 'row' }, h('strong', {}, totals.balance > 0 ? t('Balance due {amount}', { amount: fmtCents(totals.balance) }) : totals.balance < 0 ? t('Overpaid by {amount}', { amount: fmtCents(-totals.balance) }) : t('Paid in full')),
      h('span', { class: 'spacer' }),
      totals.balance > 0 && doc.status !== 'void' ? h('button', { class: 'small-btn', onclick: async () => { if (await saved()) paymentDialog(detail, meta); } }, t('Record payment')) : null));
  }
  const notes = [];
  if (online.amount) notes.push(t(online.kind === 'deposit' ? 'The customer can pay the {amount} deposit online from their link.' : 'The customer can pay {amount} online from their link.', { amount: fmtCents(online.amount) }));
  else if (meta.payments.available && !meta.payments.ready && isAdmin() && ['invoice'].includes(doc.type)) notes.push([t('Want to get paid online?'), ' ', h('a', { href: '#/?tab=getpaid' }, t('Connect your bank'))]);
  if (app) notes.push([t('Financing: {status}', { status: t(app.label) }), ` · ${fmtCents(app.amount)}`]);
  else if (financing.amount) notes.push(t('The customer can apply to finance {amount} from their link.', { amount: fmtCents(financing.amount) }));
  if (notes.length) rows.push(h('ul', { class: 'money-notes small' }, notes.map((n) => h('li', {}, n))));
  return rows.length ? h('div', { class: 'card' }, rows) : null;
}

function paymentDialog(detail, meta) {
  const { doc, totals } = detail;
  const error = h('div', { class: 'banner error', hidden: true });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api('POST', `/api/docs/${doc.id}/payments`, Object.fromEntries(new FormData(form)));
        m.close();
        toast(t('Payment recorded'));
        route();
      } catch (err) {
        error.hidden = false;
        error.textContent = err.message;
      }
    },
  },
  h('h2', {}, t('Payment on {number}', { number: doc.number })),
  error,
  h('div', { class: 'grid2' },
    h('div', {}, h('label', { for: 'p-amount' }, t('Amount')), h('input', { id: 'p-amount', name: 'amount', inputmode: 'decimal', value: dollars(totals.balance) })),
    h('div', {}, h('label', { for: 'p-date' }, t('Date received')), h('input', { id: 'p-date', name: 'paid_on', type: 'date', value: localToday() }))),
  h('div', { class: 'grid2' },
    h('div', {}, h('label', { for: 'p-method' }, t('Method')), h('select', { id: 'p-method', name: 'method' }, meta.methods.map((x) => h('option', { value: x }, t(x))))),
    h('div', {}, h('label', { for: 'p-ref' }, t('Reference'), h('span', { class: 'hint' }, ` — ${t('check #, confirmation…')}`)), h('input', { id: 'p-ref', name: 'reference' }))),
  h('div', { class: 'modal-actions' }, h('button', { type: 'button', onclick: () => m.close() }, t('Cancel')), h('button', { type: 'submit', class: 'primary' }, t('Record payment'))));
  const m = modal(form);
}

/** Pick saved items to add. */
async function catalogPicker(add) {
  const items = await api('GET', '/api/items').catch((err) => (showError(err), null));
  if (!items) return;
  if (!items.length) return toast(t('The price list is empty. Add items on the Price list tab, or tap "Save to price list" on a line.'), true);
  const picked = new Set();
  const list = h('div', { class: 'pick-list' });
  const render = (q = '') => fill(list, items.filter((i) => !q || `${i.name} ${i.description}`.toLowerCase().includes(q)).map((i) =>
    h('label', { class: 'route-pick' },
      h('input', { type: 'checkbox', checked: picked.has(i), style: 'width:auto;min-height:0;margin:.2rem .6rem 0 0', onchange: (e) => (e.target.checked ? picked.add(i) : picked.delete(i)) }),
      h('span', { class: 'grow' }, h('strong', {}, i.name), i.description ? h('span', { class: 'small muted clamp' }, i.description) : null),
      h('span', { class: 'small' }, fmtCents(i.unit_price), i.unit ? ` / ${t(i.unit)}` : ''))));
  render();
  const m = modal(
    h('h2', {}, t('Add from the price list')),
    h('input', { type: 'search', placeholder: t('Search…'), oninput: (e) => render(e.target.value.toLowerCase()) }),
    list,
    h('div', { class: 'modal-actions' },
      h('button', { onclick: () => m.close() }, t('Cancel')),
      h('button', { class: 'primary', onclick: () => {
        m.close();
        add(items.filter((i) => picked.has(i)).map((i) => ({ name: i.name, description: i.description, quantity: '1', unit: i.unit, unit_price: dollars(i.unit_price) || '0.00', taxable: Boolean(i.taxable) })));
      } }, t('Add'))));
}

// ---------------------------------------------------------------------------
// The customer's view (no sign-in), in English or Spanish
// ---------------------------------------------------------------------------

async function publicApi(method, url, body) {
  const res = await fetch(url, { method, headers: { 'X-Lang': lang, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || t('Something went wrong. Please try again.'));
  return out;
}

async function viewPublicDocument(token) {
  const params = hashParams();
  if (params.get('lang') && !state.user) setLang(params.get('lang'), { save: false });
  let data;
  try {
    data = await publicApi('GET', `/api/public/docs/${encodeURIComponent(token)}`);
  } catch (err) {
    fill($app, h('div', { class: 'public-doc' }, h('div', { class: 'row' }, h('span', { class: 'spacer' }), langSwitch()), h('div', { class: 'card' }, h('h1', {}, t('Link not available')), h('p', {}, err.message))));
    return;
  }
  const { company, doc, contact, lines, payments, pending, totals, pay, financing } = data;
  // Without a choice in the link, the customer's own language.
  if (!params.get('lang') && !state.user && !localStorage.getItem('lang')) setLang(doc.language, { save: false });
  const label = t(TYPE_NAME[doc.type]);
  const pdfUrl = `/api/public/docs/${encodeURIComponent(token)}/pdf?lang=${lang}&download=1`;
  const error = h('div', { class: 'banner error', hidden: true });
  const fail = (err) => {
    error.hidden = false;
    error.textContent = err.message;
    error.scrollIntoView({ block: 'center' });
  };
  const nameInput = h('input', { id: 'approve-name', autocomplete: 'name', placeholder: t('Your full name') });
  const agree = h('input', { type: 'checkbox', id: 'approve-ok', style: 'width:auto;min-height:0' });

  const approval = doc.can_respond ? h('form', {
    class: 'card approve-card',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!nameInput.value.trim()) return fail(new Error(t('Type your full name to approve.')));
      if (!agree.checked) return fail(new Error(t('Tick the box to accept the quote.')));
      try {
        await publicApi('POST', `/api/public/docs/${encodeURIComponent(token)}/approve`, { name: nameInput.value });
        toast(t('Thank you! The quote is approved.'));
        route();
      } catch (err) {
        fail(err);
      }
    },
  },
  h('h2', {}, t('Approve this quote')),
  h('label', { for: 'approve-name' }, t('Your name')), nameInput,
  h('label', { class: 'check-line' }, agree, totals.deposit ? t('I accept this quote and the {amount} deposit, and authorize the work described.', { amount: fmtCents(totals.deposit) }) : t('I accept this quote and authorize the work described.')),
  h('div', { class: 'modal-actions' },
    h('button', { type: 'button', onclick: () => {
      const reason = h('textarea', { id: 'decline-reason', placeholder: t('Optional: let us know why, or what would change your mind'), style: 'min-height:70px' });
      const m = modal(
        h('h2', {}, t('Decline this quote?')),
        h('label', { for: 'decline-reason' }, t('Reason')), reason,
        h('div', { class: 'modal-actions' },
          h('button', { onclick: () => m.close() }, t('Cancel')),
          h('button', { class: 'primary danger', onclick: async () => {
            m.close();
            try {
              await publicApi('POST', `/api/public/docs/${encodeURIComponent(token)}/decline`, { reason: reason.value });
              toast(t('Your answer was sent.'));
              route();
            } catch (err) {
              fail(err);
            }
          } }, t('Decline quote'))));
    } }, t('Decline')),
    h('button', { type: 'submit', class: 'primary' }, t('Approve {amount}', { amount: fmtCents(totals.total) })))) : null;

  // Pay now, or pay over time.
  const payButton = pay.amount ? h('button', { class: 'primary big', onclick: async (e) => {
    e.target.disabled = true;
    try {
      goTo((await publicApi('POST', `/api/public/docs/${encodeURIComponent(token)}/pay`)).url);
    } catch (err) {
      e.target.disabled = false;
      fail(err);
    }
  } }, pay.kind === 'deposit' ? t('Pay {amount} deposit', { amount: fmtCents(pay.amount) }) : t('Pay {amount} now', { amount: fmtCents(pay.amount) })) : null;
  const app = financing.application;
  const financeBox = financing.amount || app ? h('div', { class: 'finance-box' },
    h('strong', {}, t('Pay over time')),
    app && !['declined', 'expired', 'canceled'].includes(app.status)
      ? h('p', { class: 'small' }, t('Your financing application: {status}.', { status: t(app.label).toLowerCase() }))
      : h('p', { class: 'small' }, t('Check if you qualify in about a minute. Checking does not affect your credit score.')),
    financing.amount && (!app || ['started', 'pending', 'declined', 'expired', 'canceled'].includes(app.status)) ? h('button', { onclick: async (e) => {
      e.target.disabled = true;
      try {
        goTo((await publicApi('POST', `/api/public/docs/${encodeURIComponent(token)}/finance`)).url);
      } catch (err) {
        e.target.disabled = false;
        fail(err);
      }
    } }, app && ['started', 'pending'].includes(app.status) ? t('Continue application') : t('See if I qualify')) : null,
    financing.provider === 'wisetack' ? h('p', { class: 'tiny muted' }, t('Financing is offered by Wisetack and its lending partners, subject to approval.')) : null,
    financing.provider === 'test' ? h('p', { class: 'tiny muted' }, t('Test mode: no real loans are made.')) : null) : null;
  const payCard = payButton || financeBox ? h('div', { class: 'card pay-card' },
    h('h2', {}, doc.type === 'quote' ? t('Get started') : t('Pay this invoice')),
    payButton ? [payButton, h('p', { class: 'tiny muted' }, t('Card or bank transfer. Payments are processed securely by Stripe.'))] : null,
    financeBox) : null;

  const instructions = lang === 'es' && company.payment_instructions_es ? company.payment_instructions_es : company.payment_instructions;
  const totalRow = (text, value, cls = '') => h('div', { class: `total-row ${cls}` }, h('span', {}, text), h('span', {}, value));
  fill($app,
    h('div', { class: 'public-doc' },
      h('div', { class: 'row public-top' }, h('span', { class: 'spacer' }), langSwitch()),
      params.get('paid') === '1' ? h('div', { class: 'banner ok' }, t('Thank you! Your payment was received. Bank transfers take a few business days to clear.')) : null,
      error,
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' },
            company.logo ? h('img', { class: 'public-logo', src: `/api/public/docs/${encodeURIComponent(token)}/logo`, alt: company.name }) : null,
            company.name && !company.logo ? h('h1', { style: 'margin:0' }, company.name) : null,
            h('div', { class: 'small muted' }, [company.address, company.phone, company.email, company.website, company.license_number ? t('License # {n}', { n: company.license_number }) : ''].filter(Boolean).join(' · '))),
          h('div', { style: 'text-align:right' }, h('div', { class: 'doc-kind' }, label.toUpperCase()), h('div', { class: 'small' }, `# ${doc.number}`), statusBadge(doc))),
        h('hr'),
        h('div', { class: 'grid2' },
          h('div', {}, h('div', { class: 'small muted' }, doc.type === 'quote' ? t('Prepared for') : t('Bill to')), h('strong', {}, contact ? contactLabel(contact) : '—'),
            doc.job_address ? h('div', { class: 'small' }, t('Job site: {address}', { address: doc.job_address })) : null),
          h('div', {}, h('div', { class: 'small' }, t('Date: {date}', { date: fmtDue(doc.issue_date) })),
            doc.due_date ? h('div', { class: 'small' }, t(doc.type === 'quote' ? 'Valid until: {date}' : 'Due: {date}', { date: fmtDue(doc.due_date) })) : null)),
        doc.title ? h('h2', { style: 'margin-top:1rem' }, doc.title) : null,
        h('div', { class: 'public-lines' }, lines.map((l, i) => h('div', { class: 'public-line' },
          h('div', { class: 'grow' }, h('strong', {}, l.name), l.description ? h('div', { class: 'small muted pre' }, l.description) : null,
            h('div', { class: 'small muted' }, `${l.quantity}${l.unit ? ` ${t(l.unit)}` : ''} × ${fmtCents(l.unit_price)}`)),
          h('strong', {}, fmtCents(totals.line_amounts[i]))))),
        h('div', { class: 'totals public-totals' },
          totalRow(t('Subtotal'), fmtCents(totals.subtotal)),
          totals.discount ? totalRow(t('Discount'), `-${fmtCents(totals.discount)}`) : null,
          totals.tax ? totalRow(t('Tax ({pct}%)', { pct: doc.tax_rate }), fmtCents(totals.tax)) : null,
          totalRow(t('Total'), fmtCents(totals.total), 'grand'),
          totals.deposit ? totalRow(t('Deposit on approval ({pct}%)', { pct: doc.deposit_percent }), fmtCents(totals.deposit)) : null,
          totals.paid ? [totalRow(t('Paid'), `-${fmtCents(totals.paid)}`), totalRow(t('Balance due'), fmtCents(totals.balance), 'grand')] : null),
        payments.length ? h('p', { class: 'small muted' }, t('Payments received:'), ' ', payments.map((p) => `${fmtCents(p.amount)} (${fmtDue(p.paid_on)})`).join(', ')) : null,
        pending.length ? h('p', { class: 'small muted' }, t('{amount} paid by bank transfer is on its way.', { amount: fmtCents(pending.reduce((a, p) => a + p.amount, 0)) })) : null,
        doc.notes ? [h('h3', {}, t('Notes')), h('p', { class: 'pre' }, doc.notes)] : null,
        doc.type === 'invoice' && totals.balance > 0 && instructions ? [h('h3', {}, t('Other ways to pay')), h('p', { class: 'pre' }, instructions)] : null,
        doc.terms ? [h('h3', {}, t('Terms')), h('p', { class: 'pre small' }, doc.terms)] : null,
        doc.approved_at ? h('div', { class: 'banner ok' }, t('Approved by {name} on {date}. Thank you!', { name: doc.approved_name, date: fmtDate(doc.approved_at) })) : null,
        doc.declined_at ? h('div', { class: 'banner' }, t('This quote was declined.')) : null,
        h('div', { class: 'modal-actions' }, h('a', { class: 'btn', href: pdfUrl }, t('Download PDF')))),
      approval,
      payCard,
      h('p', { class: 'small muted powered' }, t('Sent with ProntoPaid'))));
}

const FINANCING_LABEL = { started: 'Application started', pending: 'Lender needs more information', approved: 'Approved', accepted: 'Loan accepted', funded: 'Paid by lender', declined: 'Not approved', expired: 'Expired', canceled: 'Canceled' };

/** The pretend lender (FINANCING_PROVIDER=test): walks through what a real lender would report. */
async function viewTestLender(token, appId) {
  const params = hashParams();
  if (params.get('lang') && !state.user) setLang(params.get('lang'), { save: false });
  const url = `/api/public/finance-test/${encodeURIComponent(token)}/${appId}`;
  const app = await publicApi('GET', url);
  const decide = async (decision) => {
    try {
      await publicApi('POST', url, { decision });
      location.hash = `#/view/${token}?lang=${lang}`;
    } catch (err) {
      showError(err);
    }
  };
  fill($app, h('div', { class: 'public-doc' },
    h('div', { class: 'row public-top' }, h('span', { class: 'spacer' }), langSwitch()),
    h('div', { class: 'card' },
      h('div', { class: 'banner' }, t('Test lender: this page stands in for the real lender so you can try financing. No credit check, no real loan.')),
      h('h1', {}, t('Financing for {number}', { number: app.number })),
      h('p', {}, t('{company} · amount: {amount}', { company: app.company, amount: fmtCents(app.amount) })),
      h('p', { class: 'small muted' }, t('Current status: {status}', { status: t(FINANCING_LABEL[app.status] || app.status) })),
      h('div', { class: 'modal-actions' },
        h('button', { onclick: () => decide('declined') }, t('Decline the application')),
        h('button', { onclick: () => decide('accepted') }, t('Approve, and the customer accepts')),
        h('button', { class: 'primary', onclick: () => decide('funded') }, t('Approve and pay the business'))))));
}
