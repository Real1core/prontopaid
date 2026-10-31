// Adds a demo business with customers and a price list. Sign in as demo@example.com / password123.
const path = require('path');
const config = require('../server/config');
const { openDb } = require('../server/db');
const { seedDemo } = require('../server/seed');

seedDemo(openDb(path.join(config.dataDir, 'prontopaid.db')));
console.log('Demo business added. Run "npm start" and sign in as demo@example.com / password123.');
