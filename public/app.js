'use strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $app = document.getElementById('app');
const state = { user: null, needsSetup: false };

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
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error('No connection. Check your internet and try again.');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && !url.startsWith('/auth/') && state.user) {
    state.user = null;
    location.hash = '#/signin';
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
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

function confirmDialog(title, message, okLabel = 'OK') {
  return new Promise((resolve) => {
    const m = modal(
      h('h2', {}, title),
      h('p', {}, message),
      h('div', { class: 'modal-actions' },
        h('button', { onclick: () => { m.close(); resolve(false); } }, 'Cancel'),
        h('button', { class: 'primary', onclick: () => { m.close(); resolve(true); } }, okLabel)),
    );
  });
}

/** In-page text prompt. Resolves to the trimmed text, or null if cancelled. */
function promptDialog(title, placeholder, okLabel = 'OK') {
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
      h('button', { type: 'button', onclick: () => done(null) }, 'Cancel'),
      h('button', { type: 'submit', class: 'primary' }, okLabel)));
    const m = modal(form);
    input.focus();
  });
}

/** "Oct 29, 2026" from a SQLite UTC timestamp. */
function fmtDate(sqlite) {
  if (!sqlite) return '';
  return new Date(sqlite.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "today at 3:15 PM", or "Oct 25 at 3:15 PM". */
function fmtWhen(sqlite) {
  const d = new Date(sqlite.replace(' ', 'T') + 'Z');
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return `today at ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
}

/** "Oct 29, 2026" from YYYY-MM-DD. */
function fmtDue(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Copy text, falling back to a selected text box where the clipboard isn't available. */
async function copyText(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    const box = h('textarea', { readonly: true }, text);
    const m = modal(h('h2', {}, 'Copy this'), h('p', { class: 'small muted' }, 'Select all of it and copy.'), box,
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => m.close() }, 'Done')));
    box.select();
  }
}

/** Save a file the server sends. */
async function downloadFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `Download failed (${res.status})`);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'download';
  const a = h('a', { href: URL.createObjectURL(await res.blob()), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routes = [
  [/^#\/signin/, viewSignin],
  [/^#\/setup$/, viewSetup],
  [/^#\/view\/([\w-]+)$/, (m) => viewPublicDocument(m[1]), 'public'],
  [/^#\/new\/(quote|invoice)(\?.*)?$/, (m) => viewDocument(null, m[1])],
  [/^#\/doc\/(\d+)$/, (m) => viewDocument(Number(m[1]))],
  [/^#\/?(\?.*)?$/, viewBilling],
];

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
    // A customer's quote or invoice link works without signing in.
    if (access !== 'public' && !state.user && view !== viewSignin && view !== viewSetup) {
      location.hash = state.needsSetup ? '#/setup' : '#/signin';
      return;
    }
    renderNav(hash, access === 'public');
    $app.replaceChildren(h('p', { class: 'loading' }, 'Loading…'));
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

/** Top bar: the app name (or "‹ Back" on a quote or invoice) and the account menu. */
function renderNav(hash, isPublic) {
  const bar = document.getElementById('topbar');
  bar.hidden = !state.user || isPublic;
  if (bar.hidden) return;
  const isHome = !hash.startsWith('#/doc/') && !hash.startsWith('#/new/');
  const initials = state.user.name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const menu = h('div', { class: 'account-menu', role: 'menu', hidden: true },
    h('div', { class: 'who' }, h('strong', {}, state.user.name), h('div', { class: 'small muted' }, state.user.email)),
    h('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); passwordDialog(); } }, 'Change password'),
    h('button', {
      type: 'button',
      role: 'menuitem',
      onclick: async () => {
        await api('POST', '/auth/logout').catch(() => {});
        state.user = null;
        location.hash = '#/signin';
      },
    }, 'Sign out'));
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
    'aria-label': `Account menu for ${state.user.name}`,
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
  fill(bar,
    isHome ? h('a', { href: '#/', class: 'brand' }, state.companyName || 'Quotes & Invoices')
      : h('a', { href: billingBack(), class: 'back' }, h('span', { 'aria-hidden': 'true' }, '‹'), ' Back'),
    h('span', { class: 'spacer' }),
    account,
    menu);
}

window.addEventListener('hashchange', route);

async function loadSession() {
  const me = await api('GET', '/auth/me');
  state.user = me.user;
  state.needsSetup = me.needsSetup;
  if (state.user) {
    billingMeta = null;
    state.companyName = (await getBillingMeta()).settings.company_name;
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
// Sign in, first-run setup, password
// ---------------------------------------------------------------------------

const authInput = (name, label, attrs = {}) => h('div', {}, h('label', { for: `a-${name}` }, label), h('input', { id: `a-${name}`, name, required: true, ...attrs }));

function authPage(title, intro, form) {
  fill($app, h('div', { class: 'signin' }, h('div', { class: 'card' }, h('h1', {}, title), intro ? h('p', { class: 'muted' }, intro) : null, form)));
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
  if (state.needsSetup) return void (location.hash = '#/setup');
  authPage('Sign in', null, authForm('Sign in', [
    authInput('email', 'Email', { type: 'email', autocomplete: 'username' }),
    authInput('password', 'Password', { type: 'password', autocomplete: 'current-password' }),
    h('p', { class: 'small muted' }, 'Forgot your password? Ask your administrator to set a new one on the Team page.'),
  ], async (body) => {
    await api('POST', '/auth/login', body);
    await loadSession();
    location.hash = '#/';
  }));
  document.getElementById('a-email').focus();
}

async function viewSetup() {
  if (!state.needsSetup) return void (location.hash = state.user ? '#/' : '#/signin');
  authPage('Set up Quotes & Invoices', 'Your business name goes on every quote and invoice. You will be the administrator and can add your team afterwards.', authForm('Get started', [
    authInput('company_name', 'Business name', { autocomplete: 'organization' }),
    authInput('name', 'Your name', { autocomplete: 'name' }),
    authInput('email', 'Your email', { type: 'email', autocomplete: 'username' }),
    authInput('password', 'Password', { type: 'password', autocomplete: 'new-password', minlength: 8 }),
  ], async (body) => {
    await api('POST', '/auth/setup', body);
    await loadSession();
    toast('All set. Add your company details, then make your first quote.');
    location.hash = '#/?tab=settings';
  }));
}

function passwordDialog() {
  const form = authForm('Change password', [
    authInput('current', 'Current password', { type: 'password', autocomplete: 'current-password' }),
    authInput('password', 'New password', { type: 'password', autocomplete: 'new-password', minlength: 8 }),
  ], async (body) => {
    await api('POST', '/auth/password', body);
    m.close();
    toast('Password changed');
  });
  const m = modal(h('h2', {}, 'Change password'), form, h('div', { class: 'modal-actions' }, h('button', { onclick: () => m.close() }, 'Cancel')));
}

// ---------------------------------------------------------------------------
// Team (admins)
// ---------------------------------------------------------------------------

async function teamList(el) {
  const users = await api('GET', '/api/team');
  fill(el,
    h('div', { class: 'toolbar' },
      h('p', { class: 'small muted', style: 'margin:0' }, 'Members see the quotes and invoices they make. Administrators see everyone\'s and manage the company details and team.'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: async () => { if (await userDialog(null)) route(); } }, '+ Add person')),
    users.map((u) => h('button', { type: 'button', class: 'card doc-row contact-row', onclick: async () => { if (await userDialog(u)) route(); } },
      h('div', { class: 'grow' },
        h('div', { class: 'row', style: 'gap:.5rem' }, h('strong', {}, u.name), h('span', { class: `badge ${u.role === 'admin' ? '' : 'muted'}` }, u.role === 'admin' ? 'Administrator' : 'Member'), u.active ? null : h('span', { class: 'badge bad' }, 'Turned off')),
        h('div', { class: 'small muted' }, u.email, u.last_sign_in_at ? ` · last signed in ${fmtDate(u.last_sign_in_at)}` : ' · not signed in yet')))));
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
          toast(u ? 'Saved' : `${body.name} added. Give them their email and password to sign in.`);
          done(true);
        } catch (err) {
          error.hidden = false;
          error.textContent = err.message;
        }
      },
    },
    h('h2', {}, u ? `Edit ${u.name}` : 'Add a person'),
    error,
    h('div', { class: 'grid2' },
      h('div', {}, h('label', { for: 'u-name' }, 'Name'), h('input', { id: 'u-name', name: 'name', value: u?.name || '', required: true })),
      h('div', {}, h('label', { for: 'u-email' }, 'Email'), h('input', { id: 'u-email', name: 'email', type: 'email', value: u?.email || '', required: true }))),
    h('div', { class: 'grid2' },
      h('div', {}, h('label', { for: 'u-role' }, 'Role'), h('select', { id: 'u-role', name: 'role' },
        h('option', { value: 'member', selected: u?.role !== 'admin' }, 'Member'), h('option', { value: 'admin', selected: u?.role === 'admin' }, 'Administrator'))),
      h('div', {}, h('label', { for: 'u-password' }, u ? 'New password' : 'Password', h('span', { class: 'hint' }, u ? ' — blank to keep theirs' : ' — 8+ characters')),
        h('input', { id: 'u-password', name: 'password', type: 'text', autocomplete: 'off', required: !u, minlength: 8 }))),
    u ? h('label', { class: 'check-line' }, h('input', { type: 'checkbox', name: 'active', checked: Boolean(u.active) }), 'Can sign in') : null,
    h('div', { class: 'modal-actions' },
      h('button', { type: 'button', onclick: () => done(false) }, 'Cancel'),
      h('button', { type: 'submit', class: 'primary' }, 'Save')));
    const m = modal(form);
  });
}

/** Upload or remove the logo printed on quotes and invoices (Company tab). */
function logoPicker(meta) {
  const preview = h('div', { class: 'logo-preview' });
  const show = (has) => fill(preview, has ? h('img', { src: `/api/public/logo?${Date.now()}`, alt: 'Logo' }) : h('span', { class: 'small muted' }, 'No logo yet'));
  show(meta.logo);
  const file = h('input', {
    type: 'file',
    accept: 'image/png,image/jpeg',
    hidden: true,
    onchange: async () => {
      const f = file.files[0];
      if (!f) return;
      const data = await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.readAsDataURL(f);
      });
      try {
        await api('PUT', '/api/settings/logo', { data });
        meta.logo = true;
        show(true);
        toast('Logo saved');
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
        h('button', { type: 'button', onclick: () => file.click() }, meta.logo ? 'Change logo' : 'Upload logo'),
        h('button', { type: 'button', class: 'link small danger', onclick: async () => {
          await api('DELETE', '/api/settings/logo').catch(showError);
          meta.logo = false;
          show(false);
        } }, 'Remove')),
      h('p', { class: 'small muted', style: 'margin:.3rem 0 0' }, 'PNG or JPEG, up to 2 MB. Without one, the company name is printed instead.')),
    file);
}

// ---------------------------------------------------------------------------
// Quotes & invoices
// ---------------------------------------------------------------------------

let billingMeta = null;
const getBillingMeta = async (fresh = false) => (billingMeta = !fresh && billingMeta ? billingMeta : await api('GET', '/api/meta'));
const TYPE_NAME = { quote: 'Quote', invoice: 'Invoice' };
const STATUS_CLASS = { draft: 'muted', sent: '', viewed: '', approved: 'ok', invoiced: 'ok', paid: 'ok', declined: 'bad', overdue: 'bad', void: 'bad', partial: 'warn', expired: 'warn' };
const statusBadge = (d) => h('span', { class: `badge ${STATUS_CLASS[d.display_status] ?? ''}` }, d.status_label);
const fmtCents = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const centsOf = (v) => {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const dollars = (c) => (c ? (c / 100).toFixed(2) : '');
const localToday = () => new Date().toLocaleDateString('en-CA');
const contactLabel = (c) => (c.company && c.company !== c.name ? `${c.name} · ${c.company}` : c.name);
const billingTab = () => new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || 'quotes';
let lastBillingTab = 'quotes';
const billingBack = () => `#/?tab=${lastBillingTab}`;

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

// ---- List page: quotes, invoices, customers, price list, settings ----

async function viewBilling() {
  const tab = billingTab();
  lastBillingTab = tab;
  const isAdmin = state.user.role === 'admin';
  const tabs = [['quotes', 'Quotes'], ['invoices', 'Invoices'], ['customers', 'Customers'], ['items', 'Price list']];
  if (isAdmin) tabs.push(['settings', 'Company'], ['team', 'Team']);
  const [meta, docs] = await Promise.all([getBillingMeta(), ['quotes', 'invoices'].includes(tab) ? api('GET', '/api/docs') : null]);
  const body = h('div');
  fill($app,
    h('div', { class: 'toolbar' },
      h('h1', { style: 'margin:0' }, 'Quotes & Invoices'),
      h('span', { class: 'spacer' }),
      h('a', { class: 'btn', href: '#/new/invoice' }, '+ Invoice'),
      h('a', { class: 'btn primary', href: '#/new/quote' }, '+ Quote')),
    docs ? billingSummary(docs.summary) : null,
    h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([key, label]) =>
      h('a', { href: `#/?tab=${key}`, role: 'tab', class: `tab${tab === key ? ' active' : ''}`, 'aria-selected': String(tab === key) }, label))),
    body);
  if (tab === 'quotes' || tab === 'invoices') documentList(body, tab === 'quotes' ? 'quote' : 'invoice', docs[tab]);
  else if (tab === 'customers') await customerList(body, meta);
  else if (tab === 'items') await itemList(body, meta);
  else if (tab === 'settings' && isAdmin) companySettings(body, meta);
  else if (tab === 'team' && isAdmin) await teamList(body);
}

function billingSummary(s) {
  const tile = (label, value, note, cls = '', href) => h(href ? 'a' : 'div', { class: `stat ${cls}`, href },
    h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), h('div', { class: 'small muted' }, note));
  return h('div', { class: 'stats' },
    tile('Unpaid invoices', fmtCents(s.unpaid), `${s.unpaid_count} open`, '', '#/?tab=invoices'),
    tile('Overdue', fmtCents(s.overdue), `${s.overdue_count} invoice${s.overdue_count === 1 ? '' : 's'}`, s.overdue_count ? 'bad' : '', '#/?tab=invoices'),
    tile('Quotes awaiting approval', fmtCents(s.quotes_pending), `${s.quotes_pending_count} sent`, '', '#/?tab=quotes'),
    tile('Approved, not invoiced', fmtCents(s.approved_to_invoice), `${s.approved_to_invoice_count} quote${s.approved_to_invoice_count === 1 ? '' : 's'}`, s.approved_to_invoice_count ? 'ok' : '', '#/?tab=quotes'));
}

function documentList(el, type, rows) {
  const filters = type === 'quote'
    ? [['all', 'All'], ['draft', 'Drafts'], ['waiting', 'Awaiting approval'], ['approved', 'Approved'], ['invoiced', 'Invoiced'], ['declined', 'Declined / expired']]
    : [['all', 'All'], ['draft', 'Drafts'], ['open', 'Unpaid'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['void', 'Void']];
  const groups = {
    waiting: ['sent', 'viewed'], declined: ['declined', 'expired'], open: ['sent', 'viewed', 'partial', 'overdue'],
  };
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
        h('div', { class: 'row', style: 'gap:.5rem' }, h('strong', {}, d.contact_name || 'No customer'), statusBadge(d)),
        h('div', { class: 'small muted' }, [d.number, d.title || d.job_address, fmtDue(d.issue_date)].filter(Boolean).join(' · ')),
        d.display_status === 'overdue' || (type === 'invoice' && d.due_date && ['sent', 'viewed', 'partial'].includes(d.display_status))
          ? h('div', { class: `small ${d.display_status === 'overdue' ? 'danger' : 'muted'}` }, `Due ${fmtDue(d.due_date)}`) : null),
      h('div', { class: 'doc-amount' },
        h('strong', {}, fmtCents(type === 'invoice' && !['draft', 'void'].includes(d.display_status) ? d.balance : d.total)),
        type === 'invoice' && d.paid && d.balance > 0 ? h('div', { class: 'small muted' }, `of ${fmtCents(d.total)}`) : null)))
      : h('p', { class: 'empty' }, rows.length ? 'Nothing matches.' : `No ${type}s yet. Tap "+ ${TYPE_NAME[type]}" to make one.`));
  };
  fill(el,
    h('div', { class: 'toolbar' }, h('input', { type: 'search', placeholder: 'Search customer, number or job…', style: 'max-width:340px', oninput: (e) => { q = e.target.value.toLowerCase(); render(); } })),
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
        h('div', { class: 'row', style: 'gap:.5rem' }, h('strong', {}, contactLabel(c)), h('span', { class: 'badge muted' }, meta.kinds[c.kind] || c.kind)),
        h('div', { class: 'small muted' }, [c.email, c.phone, [c.address, c.city].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || 'No contact details')),
      h('span', { class: 'small muted' }, c.document_count ? `${c.document_count} quote${c.document_count === 1 ? '' : 's'}/invoice${c.document_count === 1 ? '' : 's'}` : '')))
      : h('p', { class: 'empty' }, rows.length ? 'Nothing matches.' : showArchived ? 'No archived customers.' : 'No customers yet. Add owners, tenants, contractors and vendors you quote or bill.'));
  };
  fill(el,
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: 'Search customers…', style: 'max-width:340px', oninput: (e) => { q = e.target.value.toLowerCase(); render(); } }),
      h('span', { class: 'spacer' }),
      h('a', { class: 'small', href: showArchived ? '#/?tab=customers' : '#/?tab=customers&archived' }, showArchived ? 'Show active' : 'Show archived'),
      h('button', { class: 'primary', onclick: async () => { if (await contactDialog(null, meta)) route(); } }, '+ New customer')),
    list);
  render();
}

/** Add or edit a customer. Resolves to the customer's id once saved, or null. */
function contactDialog(c, meta, preset = {}) {
  return new Promise((resolve) => {
    const v = c || { kind: 'client', ...preset };
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
          toast('Customer saved');
          done(res.id);
        } catch (err) {
          error.hidden = false;
          error.textContent = err.message;
        }
      },
    },
    h('h2', {}, c ? 'Edit customer' : 'New customer'),
    error,
    h('div', { class: 'grid2' }, field('name', 'Name', { autocomplete: 'off' }), field('company', 'Company', { placeholder: 'optional' })),
    h('div', { class: 'grid2' },
      h('div', {}, h('label', { for: 'c-kind' }, 'Type'),
        h('select', { id: 'c-kind', name: 'kind' }, Object.entries(meta.kinds).map(([k, label]) => h('option', { value: k, selected: v.kind === k }, label)))),
      field('phone', 'Phone', { type: 'tel' })),
    field('email', 'Email', { type: 'email' }),
    h('div', { class: 'grid-address' }, field('address', 'Billing address'), field('city', 'City'), field('state', 'State'), field('zip', 'ZIP')),
    h('div', {}, h('label', { for: 'c-notes' }, 'Notes'), h('textarea', { id: 'c-notes', name: 'notes', value: v.notes || '', style: 'min-height:60px' })),
    c ? h('label', { class: 'check-line' }, h('input', { type: 'checkbox', name: 'archived', checked: Boolean(c.archived) }), 'Archived (hidden from the lists)') : null,
    h('div', { class: 'modal-actions' },
      c && state.user.role === 'admin' ? h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (!(await confirmDialog('Delete this customer?', `${c.name} will be removed.`, 'Delete'))) return;
        try {
          await api('DELETE', `/api/contacts/${c.id}`);
          toast('Customer deleted');
          done(c.id);
        } catch (err) {
          error.hidden = false;
          error.textContent = err.message;
        }
      } }, 'Delete') : null,
      c ? h('a', { class: 'btn', href: `#/new/quote?contact=${c.id}`, onclick: () => m.close() }, 'New quote') : null,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', onclick: () => done(null) }, 'Cancel'),
      h('button', { type: 'submit', class: 'primary' }, 'Save')));
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
      h('div', { class: 'doc-amount' }, h('strong', {}, fmtCents(i.unit_price)), h('div', { class: 'small muted' }, [i.unit ? `per ${i.unit}` : '', i.taxable ? 'taxable' : ''].filter(Boolean).join(' · ')))))
      : h('p', { class: 'empty' }, rows.length ? 'Nothing matches.' : 'No saved items yet. Save the work and materials you charge for often, then add them to a quote in one tap.'));
  };
  fill(el,
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: 'Search items…', style: 'max-width:340px', oninput: (e) => { q = e.target.value.toLowerCase(); render(); } }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: async () => { if (await itemDialog(null, meta)) route(); } }, '+ New item')),
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
          toast('Saved to the price list');
          done(true);
        } catch (err) {
          error.hidden = false;
          error.textContent = err.message;
        }
      },
    },
    h('h2', {}, item ? 'Edit item' : 'New price list item'),
    error,
    h('label', { for: 'i-name' }, 'Name'), h('input', { id: 'i-name', name: 'name', value: v.name || '', placeholder: 'e.g. Replace GFCI outlet' }),
    h('label', { for: 'i-description' }, 'Description', h('span', { class: 'hint' }, ' — optional; printed under the name')),
    h('textarea', { id: 'i-description', name: 'description', value: v.description || '', style: 'min-height:60px' }),
    h('div', { class: 'grid2' },
      h('div', {}, h('label', { for: 'i-price' }, 'Price'), h('input', { id: 'i-price', name: 'unit_price', inputmode: 'decimal', placeholder: '$', value: typeof v.unit_price === 'number' ? dollars(v.unit_price) : v.unit_price || '' })),
      h('div', {}, h('label', { for: 'i-unit' }, 'Per'), h('input', { id: 'i-unit', name: 'unit', value: v.unit || '', list: 'unit-options', placeholder: 'each, hour, sq ft…' }))),
    h('label', { class: 'check-line' }, h('input', { type: 'checkbox', name: 'taxable', checked: Boolean(v.taxable) }), 'Taxable (materials)'),
    unitOptions(meta),
    h('div', { class: 'modal-actions' },
      item ? h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (!(await confirmDialog('Delete this item?', `${item.name} will be removed from the price list. Quotes and invoices that use it keep it.`, 'Delete'))) return;
        await api('DELETE', `/api/items/${item.id}`).catch(showError);
        done(true);
      } }, 'Delete') : null,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', onclick: () => done(false) }, 'Cancel'),
      h('button', { type: 'submit', class: 'primary' }, 'Save')));
    const m = modal(form);
    form.name.focus();
  });
}

const unitOptions = (meta) => h('datalist', { id: 'unit-options' }, meta.units.map((u) => h('option', { value: u })));

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
        toast('Company details saved');
      } catch (err) {
        error.hidden = false;
        error.textContent = err.message;
      }
    },
  },
  h('p', { class: 'small muted' }, 'Printed at the top of every quote and invoice.'),
  error,
  logoPicker(meta),
  h('div', { class: 'grid2' }, input('company_name', 'Company name', { required: true }), input('license_number', 'License #', { placeholder: 'optional' })),
  input('company_address', 'Address', { placeholder: '123 Main St, San Bernardino, CA 92401' }),
  h('div', { class: 'grid3' }, input('company_phone', 'Phone', { type: 'tel' }), input('company_email', 'Email', { type: 'email' }), input('company_website', 'Website')),
  h('h2', { style: 'margin-top:1.25rem' }, 'Defaults'),
  h('div', { class: 'grid3' },
    input('tax_rate', 'Sales tax %', { inputmode: 'decimal' }, '— on taxable items'),
    input('quote_valid_days', 'Quotes valid for (days)', { inputmode: 'numeric' }),
    input('invoice_due_days', 'Invoices due in (days)', { inputmode: 'numeric' }),
    input('deposit_percent', 'Deposit on quotes %', { inputmode: 'decimal' }, '— 0 for none'),
    input('quote_prefix', 'Quote number prefix'),
    input('next_quote_number', 'Next quote number', { inputmode: 'numeric' }),
    input('invoice_prefix', 'Invoice number prefix'),
    input('next_invoice_number', 'Next invoice number', { inputmode: 'numeric' })),
  area('quote_terms', 'Quote terms'),
  area('invoice_terms', 'Invoice terms'),
  area('payment_instructions', 'How to pay', '— printed on unpaid invoices: checks payable to…, Zelle, ACH details'),
  h('div', { class: 'modal-actions' }, h('button', { type: 'submit', class: 'primary' }, 'Save')));
  fill(el, form);
}

// ---- One quote or invoice: edit, send, get paid ----

async function viewDocument(id, newType) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const [meta, detail, contacts] = await Promise.all([
    getBillingMeta(),
    id ? api('GET', `/api/docs/${id}`) : null,
    api('GET', '/api/contacts'),
  ]);
  const s = meta.settings;
  const type = detail ? detail.doc.type : newType;
  if (!id) lastBillingTab = `${type}s`;
  const d = detail ? { ...detail.doc } : {
    type, issue_date: localToday(), due_date: new Date(Date.now() + s[type === 'quote' ? 'quote_valid_days' : 'invoice_due_days'] * 864e5).toLocaleDateString('en-CA'), discount_type: 'amount', discount_value: 0, tax_rate: s.tax_rate,
    deposit_percent: type === 'quote' ? s.deposit_percent : 0, terms: s[`${type}_terms`], notes: '', title: '', job_address: '',
    contact_id: Number(params.get('contact')) || null,
  };
  // A customer that's archived still shows on the quotes and invoices that use it.
  if (detail?.contact && !contacts.some((c) => c.id === detail.contact.id)) contacts.push(detail.contact);
  const lines = (detail ? detail.lines : []).map((l) => ({ ...l, unit_price: dollars(l.unit_price) || '0.00', quantity: String(l.quantity) }));
  if (!lines.length) lines.push(blankLine());
  const payments = detail ? detail.payments : [];
  const paid = payments.reduce((a, p) => a + p.amount, 0);
  let dirty = !id;

  // ---- Fields ----
  const touch = () => {
    dirty = true;
    saveBtn.disabled = false;
    updateTotals();
  };
  const val = (k) => (d[k] === null || d[k] === undefined ? '' : d[k]);
  const field = (name, label, attrs = {}) => h('div', {}, h('label', { for: `d-${name}` }, label),
    h('input', { id: `d-${name}`, name, value: val(name), oninput: (e) => { d[name] = e.target.value; touch(); }, ...attrs }));

  const contactSelect = h('select', { id: 'd-contact', onchange: (e) => { d.contact_id = Number(e.target.value) || null; touch(); renderContactNote(); } });
  const renderContacts = () => {
    contactSelect.replaceChildren(h('option', { value: '' }, '— Choose a customer —'),
      ...contacts.map((c) => h('option', { value: c.id, selected: c.id === d.contact_id }, contactLabel(c))));
  };
  renderContacts();
  const contactNote = h('div', { class: 'small muted contact-note' });
  const renderContactNote = () => {
    const c = contacts.find((x) => x.id === d.contact_id);
    fill(contactNote, c ? [c.email || 'No email on file', c.phone ? ` · ${c.phone}` : '', ' · ', h('button', { type: 'button', class: 'link', onclick: async () => {
      if (await contactDialog(c, meta)) await reloadContacts();
    } }, 'Edit')] : null);
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
          h('input', { class: 'line-name', placeholder: 'Item or service', value: l.name, oninput: set('name'), 'aria-label': `Line ${i + 1} name` }),
          h('textarea', { class: 'line-desc', placeholder: 'Description (optional)', value: l.description, oninput: set('description'), rows: 1, 'aria-label': `Line ${i + 1} description` })),
        h('div', { class: 'line-nums' },
          h('label', { class: 'mini' }, 'Qty', h('input', { inputmode: 'decimal', value: l.quantity, oninput: set('quantity') })),
          h('label', { class: 'mini' }, 'Per', h('input', { value: l.unit, list: 'unit-options', placeholder: 'each', oninput: set('unit') })),
          h('label', { class: 'mini' }, 'Price', h('input', { inputmode: 'decimal', placeholder: '$', value: l.unit_price, oninput: set('unit_price') })),
          h('div', { class: 'mini' }, 'Amount', amount)),
        h('div', { class: 'line-tools' },
          h('label', { class: 'check-line small' }, h('input', { type: 'checkbox', checked: Boolean(l.taxable), onchange: set('taxable') }), 'Taxable'),
          h('span', { class: 'spacer' }),
          h('button', { type: 'button', class: 'link small', onclick: async () => {
            if (!l.name.trim()) return toast('Give the item a name first.', true);
            await itemDialog(null, meta, { name: l.name, description: l.description, unit: l.unit, unit_price: l.unit_price, taxable: l.taxable });
          } }, 'Save to price list'),
          h('button', { type: 'button', class: 'icon-btn', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(i - 1) }, '↑'),
          h('button', { type: 'button', class: 'icon-btn', title: 'Move down', 'aria-label': 'Move down', disabled: i === lines.length - 1, onclick: () => move(i + 1) }, '↓'),
          h('button', { type: 'button', class: 'icon-btn danger', title: 'Remove', 'aria-label': 'Remove line', onclick: () => {
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
  const discountType = h('select', { 'aria-label': 'Discount type', onchange: (e) => { d.discount_type = e.target.value; touch(); } },
    h('option', { value: 'amount', selected: d.discount_type === 'amount' }, '$'), h('option', { value: 'percent', selected: d.discount_type === 'percent' }, '%'));
  const totalRow = (label, value, cls = '') => h('div', { class: `total-row ${cls}` }, h('span', {}, label), h('span', {}, value));
  function updateTotals() {
    const t = billTotals(d, lines, paid);
    [...linesEl.children].forEach((row, i) => { if (row.amountEl) row.amountEl.textContent = fmtCents(t.amounts[i]); });
    fill(totalsEl,
      totalRow('Subtotal', fmtCents(t.subtotal)),
      t.discount ? totalRow('Discount', `-${fmtCents(t.discount)}`) : null,
      t.tax || Number(d.tax_rate) ? totalRow(`Tax (${Number(d.tax_rate) || 0}%)`, fmtCents(t.tax)) : null,
      totalRow('Total', fmtCents(t.total), 'grand'),
      type === 'quote' && t.deposit ? totalRow(`Deposit on approval (${d.deposit_percent}%)`, fmtCents(t.deposit)) : null,
      type === 'invoice' && paid ? [totalRow('Paid', `-${fmtCents(paid)}`), totalRow('Balance due', fmtCents(t.balance), 'grand')] : null);
  }

  // ---- Save ----
  const error = h('div', { class: 'banner error', hidden: true });
  const saveBtn = h('button', { type: 'submit', class: 'primary', disabled: !dirty }, id ? 'Save changes' : `Save ${type}`);
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
      toast(`${TYPE_NAME[type]} saved`);
      if (!id) location.hash = `#/doc/${savedId}`;
      else route();
    },
  },
  error,
  h('div', { class: 'card' },
    h('div', { class: 'grid2' },
      h('div', {}, h('label', { for: 'd-contact' }, type === 'quote' ? 'Customer' : 'Bill to'),
        h('div', { class: 'row', style: 'flex-wrap:nowrap;gap:.5rem' }, contactSelect,
          h('button', { type: 'button', title: 'New customer', onclick: async () => {
            const newId = await contactDialog(null, meta);
            if (newId) {
              await reloadContacts(newId);
              touch();
            }
          } }, '+ New')),
        contactNote),
      field('job_address', 'Job site address')),
    h('div', { class: 'grid2' },
      field('title', 'Job title', { placeholder: type === 'quote' ? 'e.g. Bathroom remodel' : 'e.g. Turnover cleaning, Unit 2B' }),
      h('div', { class: 'grid2' },
        field('issue_date', 'Date', { type: 'date' }),
        field('due_date', type === 'quote' ? 'Valid until' : 'Payment due', { type: 'date' })))),
  h('div', { class: 'card' },
    h('h2', {}, 'Items'),
    linesEl,
    unitOptions(meta),
    h('div', { class: 'row', style: 'gap:.5rem;margin-top:.75rem' },
      h('button', { type: 'button', onclick: () => addLines([blankLine()]) }, '+ Add item'),
      h('button', { type: 'button', onclick: () => catalogPicker(addLines) }, '+ From price list')),
    h('div', { class: 'totals-wrap' },
      h('div', { class: 'adjust' },
        h('div', {}, h('label', {}, 'Discount'), h('div', { class: 'row', style: 'flex-wrap:nowrap;gap:.4rem' }, discountType,
          h('input', { inputmode: 'decimal', value: d.discount_value || '', placeholder: '0', 'aria-label': 'Discount', oninput: (e) => { d.discount_value = e.target.value; touch(); } }))),
        field('tax_rate', 'Tax %', { inputmode: 'decimal' }),
        type === 'quote' ? field('deposit_percent', 'Deposit %', { inputmode: 'decimal' }) : null),
      totalsEl)),
  h('div', { class: 'card' },
    h('label', { for: 'd-notes', style: 'margin-top:0' }, 'Notes', h('span', { class: 'hint' }, ' — shown to the customer')),
    h('textarea', { id: 'd-notes', value: d.notes, oninput: (e) => { d.notes = e.target.value; touch(); } }),
    h('label', { for: 'd-terms' }, 'Terms'),
    h('textarea', { id: 'd-terms', value: d.terms, oninput: (e) => { d.terms = e.target.value; touch(); } })),
  h('div', { class: 'submit-bar' }, h('a', { class: 'btn', href: billingBack() }, id ? 'Back' : 'Cancel'), saveBtn));
  renderLines();

  cleanup = () => {
    window.onbeforeunload = null;
  };
  window.onbeforeunload = () => (dirty && id ? true : undefined);

  fill($app,
    h('div', { class: 'toolbar doc-head' },
      h('h1', { style: 'margin:0' }, id ? `${TYPE_NAME[type]} ${detail.doc.number}` : `New ${type}`),
      id ? statusBadge(detail.doc) : null,
      h('span', { class: 'spacer' }),
      id ? h('strong', { class: 'doc-head-amount' }, fmtCents(type === 'invoice' && !['draft', 'void'].includes(detail.doc.display_status) ? detail.totals.balance : detail.totals.total)) : null),
    id ? documentActions(detail, meta, saved) : null,
    id ? documentTimeline(detail) : null,
    id && type === 'invoice' ? paymentsCard(detail, meta, saved) : null,
    form);
}

function documentTimeline(detail) {
  const { doc } = detail;
  const items = [
    [`Created ${fmtDate(doc.created_at)}${doc.created_by_name ? ` by ${doc.created_by_name}` : ''}`],
    doc.quote_id ? ['Made from quote ', h('a', { href: `#/doc/${doc.quote_id}` }, doc.quote_number)] : null,
    doc.sent_at ? [`Sent ${fmtWhen(doc.sent_at)}${doc.sent_to ? ` to ${doc.sent_to}` : ''}`] : null,
    doc.viewed_at ? [`Opened by the customer ${fmtWhen(doc.viewed_at)}`] : null,
    doc.approved_at ? [h('strong', { class: 'good' }, `Approved by ${doc.approved_name}`), ` ${fmtWhen(doc.approved_at)}`] : null,
    doc.declined_at ? [h('strong', { class: 'danger' }, 'Declined'), ` ${fmtWhen(doc.declined_at)}${doc.decline_reason ? `: "${doc.decline_reason}"` : ''}`] : null,
    doc.invoice_id ? ['Invoiced on ', h('a', { href: `#/doc/${doc.invoice_id}` }, doc.invoice_number)] : null,
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
  const pdfUrl = `/api/docs/${id}/pdf`;
  return h('div', { class: 'doc-actions' },
    h('button', { class: 'primary', onclick: () => act(() => sendDialog(detail, meta)) }, doc.sent_at ? 'Send again' : 'Send'),
    h('a', { class: 'btn', href: pdfUrl, target: '_blank', onclick: async (e) => {
      e.preventDefault();
      act(async () => window.open(pdfUrl, '_blank') || downloadFile(`${pdfUrl}?download=1`));
    } }, 'View PDF'),
    h('button', { onclick: () => act(() => downloadFile(`${pdfUrl}?download=1`)) }, 'Download'),
    h('button', { onclick: () => act(async () => {
      await copyText(detail.public_url, 'Link copied. Paste it into a text or email to the customer.');
      if (doc.status === 'draft') {
        await api('POST', `/api/docs/${id}/mark-sent`, {});
        route();
      }
    }) }, 'Copy customer link'),
    isQuote && !doc.invoice_id && doc.status !== 'declined' ? h('button', { onclick: () => act(async () => {
      const res = await api('POST', `/api/docs/${id}/convert`);
      toast(res.existing ? 'This quote was already invoiced.' : 'Invoice made from the quote. Check it and send it.');
      location.hash = `#/doc/${res.id}`;
    }) }, 'Make invoice') : null,
    !isQuote && doc.display_status !== 'void' && detail.totals.balance > 0 ? h('button', { onclick: () => act(() => paymentDialog(detail, meta)) }, 'Record payment') : null,
    h('details', { class: 'more' },
      h('summary', { class: 'btn' }, 'More'),
      h('div', { class: 'more-menu' },
        isQuote && !['approved', 'invoiced'].includes(doc.display_status) ? h('button', { onclick: async () => {
          const name = await promptDialog('Who approved it?', 'Name (e.g. approved by phone)', 'Mark approved');
          if (name) status('approved', name);
        } }, 'Mark approved') : null,
        isQuote && doc.status !== 'declined' && !doc.invoice_id ? h('button', { onclick: () => status('declined') }, 'Mark declined') : null,
        doc.status === 'draft' ? h('button', { onclick: () => act(async () => { await api('POST', `/api/docs/${id}/mark-sent`, {}); route(); }) }, 'Mark sent (sent another way)') : null,
        doc.status !== 'draft' && !doc.invoice_id ? h('button', { onclick: () => status('draft') }, 'Back to draft') : null,
        !isQuote && doc.status !== 'void' ? h('button', { onclick: async () => {
          if (await confirmDialog('Void this invoice?', 'It stays in the list marked Void and no longer counts as money owed.', 'Void')) status('void');
        } }, 'Void') : null,
        !isQuote && doc.status === 'void' ? h('button', { onclick: () => status('sent') }, 'Un-void') : null,
        h('button', { onclick: () => act(async () => {
          const res = await api('POST', `/api/docs/${id}/duplicate`);
          toast(`Copied to a new ${doc.type}`);
          location.hash = `#/doc/${res.id}`;
        }) }, 'Duplicate'),
        h('button', { class: 'danger', onclick: async () => {
          const what = `${TYPE_NAME[doc.type].toLowerCase()} ${doc.number}`;
          if (!(await confirmDialog(`Delete ${what}?`, `It's removed for good${detail.payments.length ? ', with its payments' : ''}. The customer's link stops working.`, 'Delete'))) return;
          try {
            await api('DELETE', `/api/docs/${id}`);
            toast('Deleted');
            location.hash = billingBack();
          } catch (err) {
            showError(err);
          }
        } }, 'Delete'))));
}

function sendDialog(detail, meta) {
  const { doc, contact } = detail;
  const label = TYPE_NAME[doc.type].toLowerCase();
  if (!meta.mail) {
    const m = modal(
      h('h2', {}, `Send the ${label}`),
      h('p', {}, "Email isn't set up in this app yet. Send it yourself: copy the link (the customer can view", doc.type === 'quote' ? ' and approve' : '', ' it there), or download the PDF and attach it.'),
      h('div', { class: 'modal-actions' },
        h('button', { onclick: () => m.close() }, 'Close'),
        h('button', { onclick: () => downloadFile(`/api/docs/${doc.id}/pdf?download=1`).catch(showError) }, 'Download PDF'),
        h('button', { class: 'primary', onclick: async () => {
          await copyText(detail.public_url, 'Link copied');
          await api('POST', `/api/docs/${doc.id}/mark-sent`, {}).catch(showError);
          m.close();
          route();
        } }, 'Copy link')));
    return;
  }
  const settings = meta.settings;
  const to = h('input', { id: 'send-to', type: 'email', multiple: true, value: doc.sent_to || contact?.email || '', placeholder: 'name@example.com' });
  const cc = h('input', { id: 'send-cc', type: 'email', multiple: true, placeholder: 'optional' });
  const greeting = contact ? `Hi ${contact.name.split(/\s+/)[0]},` : 'Hello,';
  const message = h('textarea', { id: 'send-message' }, doc.type === 'quote'
    ? `${greeting}\n\nHere is our quote${doc.title ? ` for ${doc.title}` : ''}. You can review and approve it online with the button below.\n\nThank you,\n${state.user.name}${settings.company_name ? `\n${settings.company_name}` : ''}`
    : `${greeting}\n\nHere is your invoice${doc.title ? ` for ${doc.title}` : ''}. Please let us know if you have any questions.\n\nThank you,\n${state.user.name}${settings.company_name ? `\n${settings.company_name}` : ''}`);
  const error = h('div', { class: 'banner error', hidden: true });
  const sendBtn = h('button', { type: 'submit', class: 'primary' }, 'Send email');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      error.hidden = true;
      try {
        await api('POST', `/api/docs/${doc.id}/send`, { to: to.value, cc: cc.value, message: message.value });
        m.close();
        toast(`${TYPE_NAME[doc.type]} emailed`);
        route();
      } catch (err) {
        error.hidden = false;
        error.textContent = err.message;
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send email';
      }
    },
  },
  h('h2', {}, `Email ${label} ${doc.number}`),
  error,
  h('label', { for: 'send-to' }, 'To'), to,
  h('label', { for: 'send-cc' }, 'CC'), cc,
  h('label', { for: 'send-message' }, 'Message'), message,
  h('p', { class: 'small muted' }, `The PDF is attached, with a button to ${doc.type === 'quote' ? 'view and approve the quote' : 'view the invoice'} online.`),
  h('div', { class: 'modal-actions' }, h('button', { type: 'button', onclick: () => m.close() }, 'Cancel'), sendBtn));
  const m = modal(form);
  to.focus();
}

function paymentsCard(detail, meta, saved) {
  const { doc, payments, totals } = detail;
  if (!payments.length) return null;
  return h('div', { class: 'card' },
    h('h2', {}, 'Payments'),
    h('ul', { class: 'payment-list' }, payments.map((p) => h('li', {},
      h('span', { class: 'grow' }, h('strong', {}, fmtCents(p.amount)), ` · ${fmtDue(p.paid_on)}`, p.method ? ` · ${p.method}` : '', p.reference ? h('span', { class: 'muted' }, ` (${p.reference})`) : null),
      h('button', { class: 'link small danger', onclick: async () => {
        if (!(await confirmDialog('Remove this payment?', `${fmtCents(p.amount)} on ${fmtDue(p.paid_on)} will be removed.`, 'Remove'))) return;
        await api('DELETE', `/api/docs/${doc.id}/payments/${p.id}`).catch(showError);
        route();
      } }, 'Remove')))),
    h('div', { class: 'row' }, h('strong', {}, totals.balance > 0 ? `Balance due ${fmtCents(totals.balance)}` : totals.balance < 0 ? `Overpaid by ${fmtCents(-totals.balance)}` : 'Paid in full'),
      h('span', { class: 'spacer' }),
      totals.balance > 0 && doc.status !== 'void' ? h('button', { class: 'small-btn', onclick: async () => { if (await saved()) paymentDialog(detail, meta); } }, 'Record payment') : null));
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
        toast('Payment recorded');
        route();
      } catch (err) {
        error.hidden = false;
        error.textContent = err.message;
      }
    },
  },
  h('h2', {}, `Payment on ${doc.number}`),
  error,
  h('div', { class: 'grid2' },
    h('div', {}, h('label', { for: 'p-amount' }, 'Amount'), h('input', { id: 'p-amount', name: 'amount', inputmode: 'decimal', value: dollars(totals.balance) })),
    h('div', {}, h('label', { for: 'p-date' }, 'Date received'), h('input', { id: 'p-date', name: 'paid_on', type: 'date', value: localToday() }))),
  h('div', { class: 'grid2' },
    h('div', {}, h('label', { for: 'p-method' }, 'Method'), h('select', { id: 'p-method', name: 'method' }, meta.methods.map((x) => h('option', { value: x }, x)))),
    h('div', {}, h('label', { for: 'p-ref' }, 'Reference', h('span', { class: 'hint' }, ' — check #, confirmation…')), h('input', { id: 'p-ref', name: 'reference' }))),
  h('div', { class: 'modal-actions' }, h('button', { type: 'button', onclick: () => m.close() }, 'Cancel'), h('button', { type: 'submit', class: 'primary' }, 'Record payment')));
  const m = modal(form);
}

/** Pick saved items to add. */
async function catalogPicker(add) {
  const items = await api('GET', '/api/items').catch((err) => (showError(err), null));
  if (!items) return;
  if (!items.length) return toast('The price list is empty. Add items on the Price list tab, or tap "Save to price list" on a line.', true);
  const picked = new Set();
  const list = h('div', { class: 'pick-list' });
  const render = (q = '') => fill(list, items.filter((i) => !q || `${i.name} ${i.description}`.toLowerCase().includes(q)).map((i) =>
    h('label', { class: 'route-pick' },
      h('input', { type: 'checkbox', checked: picked.has(i), style: 'width:auto;min-height:0;margin:.2rem .6rem 0 0', onchange: (e) => (e.target.checked ? picked.add(i) : picked.delete(i)) }),
      h('span', { class: 'grow' }, h('strong', {}, i.name), i.description ? h('span', { class: 'small muted clamp' }, i.description) : null),
      h('span', { class: 'small' }, fmtCents(i.unit_price), i.unit ? ` / ${i.unit}` : ''))));
  render();
  const m = modal(
    h('h2', {}, 'Add from the price list'),
    h('input', { type: 'search', placeholder: 'Search…', oninput: (e) => render(e.target.value.toLowerCase()) }),
    list,
    h('div', { class: 'modal-actions' },
      h('button', { onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'primary', onclick: () => {
        m.close();
        add(items.filter((i) => picked.has(i)).map((i) => ({ name: i.name, description: i.description, quantity: '1', unit: i.unit, unit_price: dollars(i.unit_price) || '0.00', taxable: Boolean(i.taxable) })));
      } }, 'Add')));
}


// ---- The customer's view (no sign-in) ----

async function viewPublicDocument(token) {
  const res = await fetch(`/api/public/docs/${encodeURIComponent(token)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    fill($app, h('div', { class: 'card public-doc' }, h('h1', {}, 'Link not available'), h('p', {}, data.error || 'Something went wrong. Please try again.')));
    return;
  }
  const { company, doc, contact, lines, payments, totals } = data;
  const label = TYPE_NAME[doc.type];
  const pdfUrl = `/api/public/docs/${encodeURIComponent(token)}/pdf`;
  const respond = async (path, body) => {
    const r = await fetch(`/api/public/docs/${encodeURIComponent(token)}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || 'Something went wrong. Please try again.');
  };
  const nameInput = h('input', { id: 'approve-name', autocomplete: 'name', placeholder: 'Your full name' });
  const agree = h('input', { type: 'checkbox', id: 'approve-ok', style: 'width:auto;min-height:0' });
  const error = h('div', { class: 'banner error', hidden: true });
  const fail = (err) => {
    error.hidden = false;
    error.textContent = err.message;
  };
  const approval = doc.can_respond ? h('form', {
    class: 'card approve-card',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!nameInput.value.trim()) return fail(new Error('Type your full name to approve.'));
      if (!agree.checked) return fail(new Error('Tick the box to accept the quote.'));
      try {
        await respond('approve', { name: nameInput.value });
        toast('Thank you! The quote is approved.');
        route();
      } catch (err) {
        fail(err);
      }
    },
  },
  h('h2', {}, 'Approve this quote'),
  error,
  h('label', { for: 'approve-name' }, 'Your name'), nameInput,
  h('label', { class: 'check-line' }, agree, `I accept this quote${totals.deposit ? ` and the ${fmtCents(totals.deposit)} deposit` : ''} and authorize the work described.`),
  h('div', { class: 'modal-actions' },
    h('button', { type: 'button', onclick: () => {
      const reason = h('textarea', { id: 'decline-reason', placeholder: 'Optional: let us know why, or what would change your mind', style: 'min-height:70px' });
      const m = modal(
        h('h2', {}, 'Decline this quote?'),
        h('label', { for: 'decline-reason' }, 'Reason'), reason,
        h('div', { class: 'modal-actions' },
          h('button', { onclick: () => m.close() }, 'Cancel'),
          h('button', { class: 'primary danger', onclick: async () => {
            m.close();
            try {
              await respond('decline', { reason: reason.value });
              toast('Your answer was sent.');
              route();
            } catch (err) {
              fail(err);
            }
          } }, 'Decline quote')));
    } }, 'Decline'),
    h('button', { type: 'submit', class: 'primary' }, `Approve ${fmtCents(totals.total)}`))) : null;

  const totalRow = (text, value, cls = '') => h('div', { class: `total-row ${cls}` }, h('span', {}, text), h('span', {}, value));
  fill($app,
    h('div', { class: 'public-doc' },
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' },
            company.logo ? h('img', { class: 'public-logo', src: '/api/public/logo', alt: company.name }) : null,
            company.name && !company.logo ? h('h1', { style: 'margin:0' }, company.name) : null,
            h('div', { class: 'small muted' }, [company.address, company.phone, company.email, company.website, company.license_number ? `License # ${company.license_number}` : ''].filter(Boolean).join(' · '))),
          h('div', { style: 'text-align:right' }, h('div', { class: 'doc-kind' }, label.toUpperCase()), h('div', { class: 'small' }, `# ${doc.number}`), statusBadge(doc))),
        h('hr'),
        h('div', { class: 'grid2' },
          h('div', {}, h('div', { class: 'small muted' }, doc.type === 'quote' ? 'Prepared for' : 'Bill to'), h('strong', {}, contact ? contactLabel(contact) : '—'),
            doc.job_address ? h('div', { class: 'small' }, `Job site: ${doc.job_address}`) : null),
          h('div', {}, h('div', { class: 'small' }, `Date: ${fmtDue(doc.issue_date)}`),
            doc.due_date ? h('div', { class: 'small' }, `${doc.type === 'quote' ? 'Valid until' : 'Due'}: ${fmtDue(doc.due_date)}`) : null)),
        doc.title ? h('h2', { style: 'margin-top:1rem' }, doc.title) : null,
        h('div', { class: 'public-lines' }, lines.map((l, i) => h('div', { class: 'public-line' },
          h('div', { class: 'grow' }, h('strong', {}, l.name), l.description ? h('div', { class: 'small muted pre' }, l.description) : null,
            h('div', { class: 'small muted' }, `${l.quantity}${l.unit ? ` ${l.unit}` : ''} × ${fmtCents(l.unit_price)}`)),
          h('strong', {}, fmtCents(totals.line_amounts[i]))))),
        h('div', { class: 'totals public-totals' },
          totalRow('Subtotal', fmtCents(totals.subtotal)),
          totals.discount ? totalRow('Discount', `-${fmtCents(totals.discount)}`) : null,
          totals.tax ? totalRow(`Tax (${doc.tax_rate}%)`, fmtCents(totals.tax)) : null,
          totalRow('Total', fmtCents(totals.total), 'grand'),
          totals.deposit ? totalRow(`Deposit on approval (${doc.deposit_percent}%)`, fmtCents(totals.deposit)) : null,
          doc.type === 'invoice' && totals.paid ? [totalRow('Paid', `-${fmtCents(totals.paid)}`), totalRow('Balance due', fmtCents(totals.balance), 'grand')] : null),
        payments.length ? h('p', { class: 'small muted' }, 'Payments received: ', payments.map((p) => `${fmtCents(p.amount)} on ${fmtDue(p.paid_on)}`).join(', ')) : null,
        doc.notes ? [h('h3', {}, 'Notes'), h('p', { class: 'pre' }, doc.notes)] : null,
        doc.type === 'invoice' && totals.balance > 0 && company.payment_instructions ? [h('h3', {}, 'How to pay'), h('p', { class: 'pre' }, company.payment_instructions)] : null,
        doc.terms ? [h('h3', {}, 'Terms'), h('p', { class: 'pre small' }, doc.terms)] : null,
        doc.approved_at ? h('div', { class: 'banner ok' }, `Approved by ${doc.approved_name} on ${fmtDate(doc.approved_at)}. Thank you!`) : null,
        doc.declined_at ? h('div', { class: 'banner' }, 'This quote was declined.') : null,
        h('div', { class: 'modal-actions' }, h('a', { class: 'btn', href: `${pdfUrl}?download=1` }, 'Download PDF'))),
      approval));
}
