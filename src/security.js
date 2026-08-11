const crypto = require('node:crypto');

const APP_PEPPER = process.env.APP_PEPPER || 'change-this-pepper-before-production';

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(purpose, token) {
  return crypto.createHmac('sha256', APP_PEPPER).update(`${purpose}|${token}`).digest('base64url');
}

function encryptSecret(value) {
  const key = crypto.createHash('sha256').update(`SECRET_ENCRYPTION|${APP_PEPPER}`).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value || ''), 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptSecret(payload) {
  const [ivValue, tagValue, encryptedValue] = String(payload || '').split('.');
  if (!ivValue || !tagValue || !encryptedValue) throw new Error('Data rahasia tidak valid.');
  const key = crypto.createHash('sha256').update(`SECRET_ENCRYPTION|${APP_PEPPER}`).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(`${password}|${APP_PEPPER}`, salt, 64).toString('base64url');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = Buffer.from(hashPassword(password, salt).hash);
  const expected = Buffer.from(String(expectedHash || ''));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function approvalPinFingerprint(pin) {
  return hashToken('APPROVAL_PIN_LOOKUP', String(pin || ''));
}

function hashApprovalPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  assertApprovalPin(pin);
  const hash = crypto.scryptSync(`APPROVAL_PIN|${pin}|${APP_PEPPER}`, salt, 64).toString('base64url');
  return { salt, hash, fingerprint: approvalPinFingerprint(pin) };
}

function verifyApprovalPin(pin, salt, expectedHash) {
  const value = String(pin || '');
  if (!/^\d{8}$/.test(value) || !salt || !expectedHash) return false;
  const actual = Buffer.from(hashApprovalPin(value, salt).hash);
  const expected = Buffer.from(String(expectedHash));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function assertApprovalPin(pin) {
  if (!/^\d{8}$/.test(String(pin || ''))) {
    const error = new Error('PIN approval harus terdiri dari tepat 8 digit angka.');
    error.status = 400;
    throw error;
  }
}

function assertPassword(password) {
  const value = String(password || '');
  if (value.length < 8 || !/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    const error = new Error('Password minimal 8 karakter serta harus memuat huruf dan angka.');
    error.status = 400;
    throw error;
  }
}

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function cleanText(value, max = 500) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
}

module.exports = {
  randomToken,
  hashToken,
  encryptSecret,
  decryptSecret,
  hashPassword,
  verifyPassword,
  assertPassword,
  hashApprovalPin,
  verifyApprovalPin,
  approvalPinFingerprint,
  assertApprovalPin,
  newId,
  cleanText
};
