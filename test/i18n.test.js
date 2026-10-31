// Every piece of text the app shows has a Spanish version.
// The text is found where it's translated: t('…'), tr(lang, '…'), msg('…'), new HttpError(400, '…'),
// notices (text: '…') and the label lists (statuses, units, payment methods…).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ES, tr } = require('../public/i18n');

const root = path.join(__dirname, '..');
const FILES = ['public/app.js', ...fs.readdirSync(path.join(root, 'server')).filter((f) => f.endsWith('.js')).map((f) => `server/${f}`),
  ...fs.readdirSync(path.join(root, 'server/routes')).map((f) => `server/routes/${f}`)];

/** The text of a call starting at `start` (just after its "("), up to the matching ")". */
function callBody(src, start) {
  let depth = 1;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(start, i);
  }
  return '';
}

/** String literals at the top level of a call: not inside {params} objects, and not values compared with === / !==. */
function literals(body) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let text = '';
      for (; j < body.length && body[j] !== c; j++) {
        if (body[j] === '\\') j++;
        text += body[j];
      }
      const compared = /(===|!==)\s*$/.test(body.slice(Math.max(0, i - 5), i));
      if (depth === 0 && c !== '`' && !compared) out.push(text);
      i = j;
    }
  }
  return out;
}

function keysIn(src) {
  const keys = new Set();
  const calls = /(?:\b(?:t|t_|tl|msg)\(|\btr\(\s*[\w.]+\s*,|I18N\.tr\(\s*[\w.]+\s*,|HttpError\(\s*\d+\s*,)/g;
  let m;
  while ((m = calls.exec(src))) {
    const body = callBody(src, m.index + m[0].length);
    // For tr(lang, x) the first argument was already skipped by the pattern.
    literals(body).forEach((k) => keys.add(k));
  }
  // Notices and lender/notice text maps.
  for (const n of src.matchAll(/\btext:\s*([^\n]*)/g)) literals(n[1].replace(/,\s*params.*$/, '')).forEach((k) => keys.add(k));
  for (const n of src.matchAll(/^\s+(?:approved|accepted|funded|declined):\s*'([^']+)'/gm)) keys.add(n[1]);
  // Label lists: KEY = { a: 'Label', … } and arrays of labels.
  for (const block of src.matchAll(/const (?:\w*LABEL|TYPE_NAME|CONTACT_KINDS|LEAD_STATUS|FINANCING_LABEL)\s*=\s*\{([^}]*)\}/g)) {
    for (const v of block[1].matchAll(/:\s*'([^']+)'/g)) keys.add(v[1]);
  }
  for (const block of src.matchAll(/const (?:UNITS|PAYMENT_METHODS)\s*=\s*\[([^\]]*)\]/g)) {
    for (const v of block[1].matchAll(/'([^']+)'/g)) keys.add(v[1]);
  }
  return keys;
}

// Text passed to t() through a variable (labels of form fields, payment methods saved on payments…).
const EXTRA = ['Your name', 'Phone', 'Email', 'Project address', 'This page is not available.', 'Card (online)', 'Bank transfer (online)', 'Financing'];

const ALL = new Set(EXTRA);
for (const f of FILES) keysIn(fs.readFileSync(path.join(root, f), 'utf8')).forEach((k) => ALL.add(k));
// Not words: codes, dates, CSS, URLs, file paths.
const IGNORE = (k) => !/[a-z]{2}/i.test(k) || /^(en|es|lang|POST|GET|PUT|DELETE|#|\/|https?:)/.test(k) || /^[\w-]+$/.test(k) && k === k.toLowerCase() && !['each', 'hour', 'day', 'job', 'trip', 'gallon'].includes(k);

test('i18n: every piece of text has Spanish', () => {
  const missing = [...ALL].filter((k) => !IGNORE(k) && !Object.prototype.hasOwnProperty.call(ES, k)).sort();
  assert.deepStrictEqual(missing, [], `Missing Spanish for:\n${missing.map((k) => JSON.stringify(k)).join(',\n')}`);
});

test('i18n: Spanish keeps every {placeholder}', () => {
  const bad = Object.entries(ES).filter(([en, es]) => {
    const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
    return names(en) !== names(es);
  });
  assert.deepStrictEqual(bad, []);
});

test('i18n: placeholders are filled in, and unknown text stays English', () => {
  assert.strictEqual(tr('es', 'Line {n} needs a name.', { n: 3 }), 'La línea 3 necesita un nombre.');
  assert.strictEqual(tr('en', 'Line {n} needs a name.', { n: 3 }), 'Line 3 needs a name.');
  assert.strictEqual(tr('es', 'Something new'), 'Something new');
});
