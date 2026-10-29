// Email through the SMTP server in .env (see README). Returns null when email isn't set up.
const config = require('./config');

let transport;
function mailer() {
  if (!config.mailEnabled) return null;
  if (!transport) {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  /** @param {{to: string[], cc?: string[], replyTo?: string, fromName?: string, subject: string, html: string, attachments?: {name, contentType, content: Buffer}[]}} mail */
  return ({ to, cc = [], replyTo, fromName, subject, html, attachments = [] }) => transport.sendMail({
    from: fromName ? { name: fromName, address: config.smtp.from } : config.smtp.from,
    to,
    cc,
    replyTo,
    subject,
    html,
    attachments: attachments.map((a) => ({ filename: a.name, contentType: a.contentType, content: a.content })),
  });
}

module.exports = { mailer };
