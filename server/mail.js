// Email through the SMTP server in .env (see README). mailer() is null when email isn't set up.
const config = require('./config');

// Tests put a fake sender here.
const services = { mail: null };

let transport;
function smtp() {
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

const mailer = () => services.mail || smtp();

module.exports = { mailer, services };
