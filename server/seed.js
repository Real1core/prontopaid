// Sample customers and price list items, used by `npm run seed` to try the app.
function seedSamples(db) {
  if (!db.prepare('SELECT 1 FROM contacts').get()) {
    const contact = db.prepare('INSERT INTO contacts (name, company, kind, email, phone, address, city, state, zip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    contact.run('Pat Owner', '', 'owner', 'owner@example.com', '909-555-0110', '2465 N Del Rosa Avenue', 'San Bernardino', 'CA', '92404');
    contact.run('Highland Holdings LLC', 'Highland Holdings LLC', 'owner', 'ap@example.com', '', '780 W Highland Avenue', 'San Bernardino', 'CA', '92405');
    contact.run('Ray Ortiz', 'Ortiz Plumbing', 'contractor', 'ray@example.com', '909-555-0142', '', '', '', '');
    contact.run('Ace Supply', 'Ace Supply Co.', 'vendor', 'orders@example.com', '', '', '', '', '');
  }
  if (!db.prepare('SELECT 1 FROM catalog_items').get()) {
    const item = db.prepare('INSERT INTO catalog_items (name, description, unit, unit_price, taxable) VALUES (?, ?, ?, ?, ?)');
    item.run('Handyman labor', 'General repairs', 'hour', 7500, 0);
    item.run('Service call', 'Trip charge, first half hour included', 'trip', 9500, 0);
    item.run('Replace GFCI outlet', 'Includes outlet and cover plate', 'each', 14500, 0);
    item.run('Smoke / CO detector', 'Supply and install, 10-year battery', 'each', 6500, 1);
    item.run('Interior paint', 'Two coats, walls only', 'sq ft', 250, 0);
    item.run('Unit turnover cleaning', 'Kitchen, baths, floors, windows and blinds', 'job', 35000, 0);
  }
}

module.exports = { seedSamples };
