'use strict';

const crypto = require('node:crypto');

const SESSION_DAYS = 14;
const COOKIE_NAME = 'crm_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return { token, expires };
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function userForToken(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.org_id, u.name, u.email, u.role, o.name AS org_name, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id JOIN orgs o ON o.id = u.org_id
    WHERE s.token = ?`).get(token);
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    destroySession(db, token);
    return null;
  }
  delete row.expires_at;
  return { ...row };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, expires, secure) {
  const attrs = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (expires) attrs.push(`Expires=${new Date(expires).toUTCString()}`);
  else attrs.push('Max-Age=0');
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

// Simple in-memory limiter for login attempts, keyed by IP + email.
class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  allow(key) {
    const now = Date.now();
    const recent = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  userForToken,
  parseCookies,
  sessionCookie,
  RateLimiter,
};
