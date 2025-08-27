const crypto = require('crypto');
const { getKV, saveKV } = require('../db');

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = 4 - (str.length % 4);
  if (pad !== 4) str += '='.repeat(pad);
  return Buffer.from(str, 'base64');
}

async function ensureAdminUser({ email, password }) {
  const key = 'admin:user';
  const existing = await getKV(key);
  if (existing && existing.email === email) return; // do not overwrite automatically
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 150000;
  const hash = await pbkdf2Async(password, salt, iterations);
  const value = {
    email,
    algo: 'pbkdf2_sha256',
    iterations,
    salt,
    hash,
    created_at: new Date().toISOString()
  };
  await saveKV(key, value);
}

function pbkdf2Async(password, salt, iterations) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, 32, 'sha256', (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey.toString('hex'));
    });
  });
}

async function verifyPassword(email, password) {
  const user = await getKV('admin:user');
  if (!user || user.email !== email) return false;
  const hash = await pbkdf2Async(password, user.salt, user.iterations);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

async function getOrCreateSessionSecret() {
  const key = 'admin:session_secret';
  const existing = await getKV(key);
  if (existing && existing.secret) return Buffer.from(existing.secret, 'hex');
  const secret = crypto.randomBytes(32);
  await saveKV(key, { secret: secret.toString('hex'), created_at: new Date().toISOString() });
  return secret;
}

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

function createSessionToken({ sub, ttlMs }, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Date.now();
  const payload = { sub, iat: now, exp: now + (ttlMs || 3600000), ver: 1 };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = b64url(sign(`${h}.${p}`, secret));
  return `${h}.${p}.${sig}`;
}

function verifySessionToken(token, secret) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const expected = b64url(sign(`${h}.${p}`, secret));
    const ok = crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected));
    if (!ok) return null;
    const payload = JSON.parse(b64urlDecode(p).toString('utf8'));
    return payload;
  } catch (_) {
    return null;
  }
}

module.exports = {
  ensureAdminUser,
  verifyPassword,
  getOrCreateSessionSecret,
  createSessionToken,
  verifySessionToken
};

