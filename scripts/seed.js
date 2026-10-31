// Adds sample customers and price list items so you can try the app.
const path = require('path');
const config = require('../server/config');
const { openDb } = require('../server/db');
const { seedSamples } = require('../server/seed');

seedSamples(openDb(path.join(config.dataDir, 'prontopaid.db')));
console.log('Sample customers and price list added. Run "npm start".');
