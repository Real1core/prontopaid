const path = require('path');
const config = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');

const db = openDb(path.join(config.dataDir, 'prontopaid.db'));
createApp(db).listen(config.port, () => {
  console.log(`ProntoPaid running at ${config.baseUrl || `http://localhost:${config.port}`}`);
  if (!config.mailEnabled) console.log('Email is off (SMTP_HOST and MAIL_FROM not set): send quotes by link or PDF.');
});
