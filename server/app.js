const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const config = require('./config');
const { HttpError, requestLang } = require('./util');
const { tr } = require('../public/i18n');
const { authRouter, teamRouter, loadUser } = require('./auth');
const { billingRouter } = require('./routes/billing');
const { paymentsRouter, webhookRouter } = require('./routes/payments');
const { publicRouter, siteRouter } = require('./routes/public');
const { sitesRouter } = require('./routes/sites');
const billing = require('./billing');

function createApp(db) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Stripe and the lender sign their notices over the exact body, so these come before the body parser.
  app.use('/api/webhooks', webhookRouter(db));

  app.use(
    cookieSession({
      name: 'prontopaid_session',
      keys: [config.sessionSecret],
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      httpOnly: true,
      secure: config.baseUrl.startsWith('https://'),
    }),
  );
  app.use(loadUser(db));
  app.use(express.json({ limit: '8mb' })); // logos and landing page photos are sent as data URLs
  app.use((req, _res, next) => {
    req.body ??= {}; // Express 5 leaves it undefined for requests without a body
    next();
  });

  app.use('/auth', authRouter(db, { onSignup: (d, businessId, s) => billing.saveSettings(d, businessId, s) }));
  app.use('/api/team', teamRouter(db));
  app.use('/api/public', publicRouter(db)); // a customer's quote or invoice link, no sign-in
  app.use('/api/payments', paymentsRouter(db));
  app.use('/api', sitesRouter(db));
  app.use('/api', billingRouter(db));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use('/s', siteRouter(db)); // businesses' landing pages

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let status = err.status || err.statusCode || 500;
    if (err.type === 'entity.too.large') status = 413;
    // The app's own (HttpError) messages are written for people, so they're shown, in their language; others aren't.
    const lang = requestLang(req);
    const expected = err instanceof HttpError;
    if (status >= 500 && !expected) console.error(err);
    const message = status === 413 ? tr(lang, 'That file is too large.')
      : expected ? err.translated(lang)
        : status >= 500 ? tr(lang, 'Something went wrong. Please try again.') : err.message;
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp };
