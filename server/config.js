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
  // Payments, bank connection and the Premium subscription (see server/stripe.js and README).
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    // The Connect endpoint (events from businesses' accounts) has its own secret.
    connectWebhookSecret: env.STRIPE_CONNECT_WEBHOOK_SECRET || '',
    // The monthly Premium price (Stripe Dashboard > Products), e.g. price_123.
    premiumPriceId: env.STRIPE_PREMIUM_PRICE_ID || '',
    // ProntoPaid's share of each online payment, in percent (0 = none). Stripe's own fees come out of the business's share.
    platformFeePercent: Number(env.PLATFORM_FEE_PERCENT || 0),
  },
  // Customer financing (see server/financing.js). "wisetack" once ProntoPaid is a Wisetack partner,
  // "test" for a pretend lender to try the flow, blank to turn financing off.
  financing: {
    provider: ['wisetack', 'test'].includes(env.FINANCING_PROVIDER) ? env.FINANCING_PROVIDER : '',
    wisetack: {
      apiUrl: (env.WISETACK_API_URL || 'https://api.wisetack.com').replace(/\/$/, ''),
      apiKey: env.WISETACK_API_KEY || '',
      webhookSecret: env.WISETACK_WEBHOOK_SECRET || '',
      // Where a business enrolls as a Wisetack merchant through ProntoPaid (from Wisetack's partner team).
      signupUrl: env.WISETACK_SIGNUP_URL || '',
    },
    // The amounts a customer can finance, in dollars.
    minAmount: Number(env.FINANCING_MIN || 500),
    maxAmount: Number(env.FINANCING_MAX || 25000),
  },
  // Turn Premium on for every business without a subscription (local testing only).
  premiumForAll: /^(1|true|yes)$/i.test(env.PREMIUM_FOR_ALL || ''),
};
config.mailEnabled = Boolean(config.smtp.host && config.smtp.from);
config.stripeEnabled = Boolean(config.stripe.secretKey);

module.exports = config;
