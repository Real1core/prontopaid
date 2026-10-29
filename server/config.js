const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const env = process.env;
const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));

// Without SESSION_SECRET, a random one is made once and kept in the data folder, so sign-ins
// survive restarts.
function sessionSecret() {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const file = path.join(dataDir, 'session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

const config = {
  port: Number(env.PORT || 3000),
  // Public address used in the links sent to customers. Blank: the address the app was opened at.
  baseUrl: (env.BASE_URL || '').replace(/\/$/, ''),
  dataDir,
  sessionSecret: sessionSecret(),
  timezone: env.APP_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
  // Email through any SMTP server (Microsoft 365, Google Workspace, SendGrid…). Blank host: no email;
  // quotes and invoices are sent by copying the link or downloading the PDF.
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: /^(1|true|yes)$/i.test(env.SMTP_SECURE || '') || Number(env.SMTP_PORT) === 465,
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || env.SMTP_USER || '',
  },
};
config.mailEnabled = Boolean(config.smtp.host && config.smtp.from);

module.exports = config;
