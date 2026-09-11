import crypto from 'node:crypto';
import { get } from './db.js';
import { SESSION_SECRET as SECRET } from './config.js';

const TTL_MS = 12 * 60 * 60 * 1000; // 12h

/* ---------- password hashing: scrypt (built in, no native deps) ---------- */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${key}`;
}

export function verifyPassword(pw, stored) {
  const [scheme, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const candidate = crypto.scryptSync(pw, salt, 64);
  const expected = Buffer.from(key, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/* ---------- stateless signed session token (compact JWT-style) ---------- */
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = d => crypto.createHmac('sha256', SECRET).update(d).digest('base64url');

export function issueToken(user) {
  const body = b64({ id: user.id, role: user.role, exp: Date.now() + TTL_MS });
  return `${body}.${sign(body)}`;
}

export function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = sign(body);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}

/* ---------- express middleware ---------- */
export function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const payload = readToken(header.startsWith('Bearer ') ? header.slice(7) : null);
  if (!payload) return res.status(401).json({ error: 'Not authenticated' });

  const user = get(`SELECT * FROM users WHERE id = ?`, payload.id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

  delete user.password_hash;
  req.user = user;
  next();
}

export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not permitted for your role' });

/**
 * Hard gate: until the T&C are accepted the account is 'pending_agreement'
 * and every route except the agreement endpoints is closed.
 */
export function requireAgreement(req, res, next) {
  if (req.user.role !== 'admin' && req.user.status === 'pending_agreement') {
    return res.status(428).json({ error: 'Agreement not accepted', code: 'AGREEMENT_REQUIRED' });
  }
  next();
}

/**
 * Second gate, applied after the agreement one: the password handed over at
 * registration is temporary, so nothing else opens until it has been replaced.
 */
export function requirePasswordSet(req, res, next) {
  if (req.user.must_change_pw) {
    return res.status(428).json({
      error: 'You must set your own password before continuing',
      code: 'PASSWORD_CHANGE_REQUIRED'
    });
  }
  next();
}
