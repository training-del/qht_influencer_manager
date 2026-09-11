import { Router } from 'express';
import { get, run, audit } from '../lib/db.js';
import { hashPassword, verifyPassword, issueToken, authenticate } from '../lib/auth.js';
import { normalisePhone } from '../lib/phone.js';
import { checkPassword } from '../lib/password.js';

const r = Router();

r.post('/login', (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ error: 'Phone/email and password are required' });

  // Accept "+91 98765 43210", "9198765 43210" or the bare 10 digits for the same account.
  const asPhone = normalisePhone(identifier);
  const user = get(
    `SELECT * FROM users WHERE phone = ? OR phone = ? OR lower(email) = lower(?)`,
    String(identifier).trim(), asPhone, identifier);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Contact QHT admin.' });

  audit(user.id, 'login', 'users', user.id);
  delete user.password_hash;
  res.json({
    token: issueToken(user),
    user,
    // the client uses this to decide: agreement screen vs dashboard
    needsAgreement: user.role !== 'admin' && user.status === 'pending_agreement',
    mustChangePassword: !!user.must_change_pw
  });
});

r.get('/me', authenticate, (req, res) => {
  const parent = req.user.parent_id
    ? get(`SELECT id, full_name, role FROM users WHERE id = ?`, req.user.parent_id)
    : null;
  res.json({
    user: req.user,
    registeredBy: parent,
    needsAgreement: req.user.role !== 'admin' && req.user.status === 'pending_agreement',
    mustChangePassword: !!req.user.must_change_pw
  });
});

r.post('/change-password', authenticate, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  const strength = checkPassword(newPassword);
  if (!strength.ok) return res.status(400).json({ error: strength.error, rule: strength.rule });

  const full = get(`SELECT password_hash FROM users WHERE id = ?`, req.user.id);
  if (!verifyPassword(currentPassword || '', full.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'Choose a password different from the temporary one' });
  }
  run(`UPDATE users SET password_hash = ?, must_change_pw = 0, updated_at = datetime('now') WHERE id = ?`,
      hashPassword(newPassword), req.user.id);
  audit(req.user.id, 'change_password', 'users', req.user.id);
  res.json({ ok: true });
});

export default r;
