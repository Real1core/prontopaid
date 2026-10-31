const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Every business that signs up gets its own customers, price list, quotes, invoices, team and
// landing page; every table below (except the per-business ones) carries business_id.
// Amounts are stored in cents.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  -- Premium, through a Stripe subscription (see server/stripe.js).
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'premium')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT,
  -- Getting paid: the business's Stripe Connect account, which holds its bank details.
  stripe_account_id TEXT UNIQUE,
  stripe_charges_enabled INTEGER NOT NULL DEFAULT 0,
  stripe_payouts_enabled INTEGER NOT NULL DEFAULT 0,
  stripe_details_submitted INTEGER NOT NULL DEFAULT 0,
  -- Customer financing through Wisetack (see server/financing.js).
  wisetack_merchant_id TEXT,
  financing_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es')),
  active INTEGER NOT NULL DEFAULT 1,
  last_sign_in_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The company details printed on quotes and invoices, one row per setting.
CREATE TABLE IF NOT EXISTS settings (
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (business_id, key)
);

-- Who a quote or invoice is for: a client, property owner, contractor, vendor…
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'client',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  zip TEXT NOT NULL DEFAULT '',
  -- The language their quotes, invoices and emails are in.
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es')),
  notes TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The price list: saved items to add to a quote or invoice in one tap.
CREATE TABLE IF NOT EXISTS catalog_items (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  unit_price INTEGER NOT NULL DEFAULT 0,
  taxable INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('quote', 'invoice')),
  number TEXT NOT NULL,
  -- Quotes: draft, sent, approved, declined. Invoices: draft, sent, void (paid comes from the payments).
  status TEXT NOT NULL DEFAULT 'draft',
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  -- On an invoice: the quote it was made from.
  quote_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  job_address TEXT NOT NULL DEFAULT '',
  issue_date TEXT NOT NULL,
  -- Quotes: valid until. Invoices: payment due.
  due_date TEXT,
  discount_type TEXT NOT NULL DEFAULT 'amount' CHECK (discount_type IN ('amount', 'percent')),
  discount_value REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  deposit_percent REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  terms TEXT NOT NULL DEFAULT '',
  -- Lets the customer open, approve, pay or download it without signing in.
  public_token TEXT NOT NULL UNIQUE,
  sent_at TEXT,
  sent_to TEXT,
  viewed_at TEXT,
  approved_at TEXT,
  approved_name TEXT,
  declined_at TEXT,
  decline_reason TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (business_id, type, number)
);

CREATE TABLE IF NOT EXISTS document_lines (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT '',
  unit_price INTEGER NOT NULL DEFAULT 0,
  taxable INTEGER NOT NULL DEFAULT 0
);

-- Money received on an invoice (or a quote's deposit): recorded by hand, paid online through
-- Stripe, or paid by the customer's lender.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  paid_on TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  -- 'manual', 'online' (Stripe) or 'financing'. Online and financed payments can't be removed by hand.
  source TEXT NOT NULL DEFAULT 'manual',
  -- The Stripe Checkout session or lender transaction, so a repeated notice isn't counted twice.
  external_id TEXT UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Payments a customer started online. Card payments finish at once; bank (ACH) payments take a
-- few days, so they show as pending until Stripe says they went through.
CREATE TABLE IF NOT EXISTS online_payments (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  checkout_session_id TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'succeeded', 'failed', 'expired')),
  method TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A customer's application to pay over time (see server/financing.js).
CREATE TABLE IF NOT EXISTS financing_applications (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_id TEXT,
  amount INTEGER NOT NULL,
  -- started, pending (lender needs more), approved, accepted (customer took the loan), funded, declined, expired, canceled
  status TEXT NOT NULL DEFAULT 'started',
  provider_status TEXT,
  apply_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, external_id)
);

-- Premium: the business's landing page. Text is kept in English and Spanish ({en: {...}, es: {...}}).
CREATE TABLE IF NOT EXISTS sites (
  business_id INTEGER PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  published INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '{}',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  service_area TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#1d4e89',
  default_language TEXT NOT NULL DEFAULT 'en',
  photo TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- People who asked for a quote through a landing page.
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  service TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'quoted', 'won', 'lost')),
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What the bell in the app shows: new leads, approvals, payments, financing. One row per person.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  -- English text with {placeholders}; params fill them in, in each person's language.
  text TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  link TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_business ON users(business_id);
CREATE INDEX IF NOT EXISTS idx_contacts_business ON contacts(business_id, archived);
CREATE INDEX IF NOT EXISTS idx_items_business ON catalog_items(business_id);
CREATE INDEX IF NOT EXISTS idx_documents_business ON documents(business_id, type);
CREATE INDEX IF NOT EXISTS idx_document_lines ON document_lines(document_id, position);
CREATE INDEX IF NOT EXISTS idx_payments_document ON payments(document_id);
CREATE INDEX IF NOT EXISTS idx_online_payments_document ON online_payments(document_id);
CREATE INDEX IF NOT EXISTS idx_financing_document ON financing_applications(document_id);
CREATE INDEX IF NOT EXISTS idx_leads_business ON leads(business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
