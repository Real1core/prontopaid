// Each business's logo, printed on its quotes and invoices and shown on its landing page.
// Uploaded on the Company tab; kept as data/logos/<business id>.png or .jpg.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { HttpError } = require('./util');

const TYPES = { png: 'image/png', jpg: 'image/jpeg' };
const MAX_BYTES = 2 * 1024 * 1024;
const dir = () => path.join(config.dataDir, 'logos');
const fileFor = (businessId, ext) => path.join(dir(), `${Number(businessId)}.${ext}`);

/** The logo's path and type, or null when there isn't one. */
function current(businessId) {
  for (const [ext, mime] of Object.entries(TYPES)) if (fs.existsSync(fileFor(businessId, ext))) return { path: fileFor(businessId, ext), mime };
  return null;
}

/** A PNG or JPEG sent as a data URL ("data:image/png;base64,…"), checked by its first bytes. */
function decodeImage(dataUrl, maxBytes = MAX_BYTES) {
  const m = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'The image must be a PNG or JPEG.');
  const data = Buffer.from(m[2], 'base64');
  if (data.length > maxBytes) throw new HttpError(400, 'The image is too large ({mb} MB max).', { mb: Math.round(maxBytes / 1024 / 1024) });
  const png = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (!png && !jpg) throw new HttpError(400, 'The image must be a PNG or JPEG.');
  return { data, ext: png ? 'png' : 'jpg', mime: png ? 'image/png' : 'image/jpeg' };
}

function save(businessId, dataUrl) {
  const img = decodeImage(dataUrl);
  remove(businessId);
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(fileFor(businessId, img.ext), img.data);
}

function remove(businessId) {
  for (const ext of Object.keys(TYPES)) fs.rmSync(fileFor(businessId, ext), { force: true });
}

module.exports = { current, save, remove, decodeImage };
