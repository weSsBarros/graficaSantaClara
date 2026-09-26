'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { HttpError, nowIso, DAY_MS } = require('./util');
const { can } = require('./permissions');

const COOKIE = 'gsc_sess';

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPin(pin, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(pin), Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function validatePin(pin) {
  if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) {
    throw new HttpError(400, 'O PIN deve ter de 4 a 8 números.');
  }
  if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) {
    throw new HttpError(400, 'PIN muito fácil (números repetidos ou em sequência). Escolha outro.');
  }
  return pin;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(token),
    userId,
    new Date(now).toISOString(),
    new Date(now + config.sessionDays * DAY_MS).toISOString()
  );
  // limpeza oportunista de sessões vencidas
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  return token;
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function destroyUserSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: config.sessionDays * DAY_MS,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

/** Middleware: carrega req.user a partir do cookie de sessão (se houver). */
function loadUser(db) {
  const stmt = db.prepare(
    `SELECT u.id, u.name, u.role, u.must_change_pin, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`
  );
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.sessionToken = token || null;
    req.user = token ? stmt.get(sha256(token), nowIso()) || null : null;
    next();
  };
}

function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Faça login para continuar.'));
  next();
}

function requirePerm(perm) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Faça login para continuar.'));
    if (!can(req.user, perm)) return next(new HttpError(403, 'Você não tem permissão para esta ação.'));
    next();
  };
}

module.exports = {
  COOKIE,
  hashPin,
  verifyPin,
  validatePin,
  createSession,
  destroySession,
  destroyUserSessions,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  loadUser,
  requireUser,
  requirePerm,
};
