// A demo business to try the app: sign in as demo@example.com / password123.
const { hashPassword } = require('./auth');
const billing = require('./billing');

function seedDemo(db) {
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get('demo@example.com');
  if (!user) {
    const businessId = Number(db.prepare("INSERT INTO businesses (name) VALUES ('Ortiz Home Services')").run().lastInsertRowid);
    billing.saveSettings(db, businessId, { company_name: 'Ortiz Home Services', company_email: 'demo@example.com', company_phone: '909-555-0100', company_address: '123 Main St, San Bernardino, CA 92401', tax_rate: 7.75 });
    db.prepare("INSERT INTO users (business_id, email, name, role, password_hash) VALUES (?, 'demo@example.com', 'Dana Ortiz', 'admin', ?)").run(businessId, hashPassword('password123'));
    user = db.prepare('SELECT * FROM users WHERE email = ?').get('demo@example.com');
  }
  const b = user.business_id;
  if (!db.prepare('SELECT 1 FROM contacts WHERE business_id = ?').get(b)) {
    const contact = db.prepare('INSERT INTO contacts (business_id, name, company, kind, email, phone, address, city, state, zip, language) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    contact.run(b, 'Pat Owner', '', 'owner', 'owner@example.com', '909-555-0110', '2465 N Del Rosa Avenue', 'San Bernardino', 'CA', '92404', 'en');
    contact.run(b, 'María González', '', 'client', 'maria@example.com', '909-555-0123', '1590 E Pacific Street', 'San Bernardino', 'CA', '92404', 'es');
    contact.run(b, 'Highland Holdings LLC', 'Highland Holdings LLC', 'manager', 'ap@example.com', '', '780 W Highland Avenue', 'San Bernardino', 'CA', '92405', 'en');
  }
  if (!db.prepare('SELECT 1 FROM catalog_items WHERE business_id = ?').get(b)) {
    const item = db.prepare('INSERT INTO catalog_items (business_id, name, description, unit, unit_price, taxable) VALUES (?, ?, ?, ?, ?, ?)');
    item.run(b, 'Handyman labor', 'General repairs', 'hour', 7500, 0);
    item.run(b, 'Service call', 'Trip charge, first half hour included', 'trip', 9500, 0);
    item.run(b, 'Replace GFCI outlet', 'Includes outlet and cover plate', 'each', 14500, 0);
    item.run(b, 'Smoke / CO detector', 'Supply and install, 10-year battery', 'each', 6500, 1);
    item.run(b, 'Interior paint', 'Two coats, walls only', 'sq ft', 250, 0);
    item.run(b, 'Water heater replacement', '40-gallon gas, haul away old unit', 'each', 185000, 1);
  }
}

module.exports = { seedDemo };
