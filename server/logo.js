// The company logo printed on quotes and invoices, uploaded on the Company page.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { HttpError } = require('./util');

const TYPES = { png: 'image/png', jpg: 'image/jpeg' };
const MAX_BYTES = 2 * 1024 * 1024;
const fileFor = (ext) => path.join(config.dataDir, `logo.${ext}`);

/** The logo's path and type, or null when there isn't one. */
function current() {
  for (const [ext, mime] of Object.entries(TYPES)) if (fs.existsSync(fileFor(ext))) return { path: fileFor(ext), mime };
  return null;
}

/** Save a logo sent as a data URL ("data:image/png;base64,…"). */
function save(dataUrl) {
  const m = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'The logo must be a PNG or JPEG image.');
  const data = Buffer.from(m[2], 'base64');
  if (data.length > MAX_BYTES) throw new HttpError(400, 'The logo is too large (2 MB max).');
  const png = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (!png && !jpg) throw new HttpError(400, 'The logo must be a PNG or JPEG image.');
  remove();
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(fileFor(png ? 'png' : 'jpg'), data);
}

function remove() {
  for (const ext of Object.keys(TYPES)) fs.rmSync(fileFor(ext), { force: true });
}

module.exports = { current, save, remove };
