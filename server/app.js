const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const config = require('./config');
const { HttpError } = require('./util');
const { authRouter, teamRouter, loadUser } = require('./auth');
const { billingRouter, publicRouter } = require('./routes/billing');
const billing = require('./billing');

function createApp(db) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    cookieSession({
      name: 'quotes_session',
      keys: [config.sessionSecret],
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      httpOnly: true,
      secure: config.baseUrl.startsWith('https://'),
    }),
  );
  app.use(loadUser(db));
  app.use(express.json({ limit: '4mb' })); // a logo is sent as a data URL
  app.use((req, _res, next) => {
    req.body ??= {}; // Express 5 leaves it undefined for requests without a body
    next();
  });

  app.use('/auth', authRouter(db, { onSetup: (s) => billing.saveSettings(db, s) }));
  app.use('/api/team', teamRouter(db));
  app.use('/api/public', publicRouter(db)); // a customer's quote or invoice link, no sign-in
  app.use('/api', billingRouter(db));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let status = err.status || err.statusCode || 500;
    if (err.type === 'entity.too.large') status = 413;
    // The app's own (HttpError) messages are written for people, so they're shown; others aren't.
    const expected = err instanceof HttpError || status === 413;
    if (status >= 500 && !expected) console.error(err);
    const message = status === 413 ? 'That file is too large.' : status >= 500 && !expected ? 'Something went wrong. Please try again.' : err.message;
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp };
