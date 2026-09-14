/**
 * Device registration for push notifications — the local server's copy of
 * worker/src/routes/devices.js, so the app can be tried end to end locally.
 * Nothing is sent from here; the scheduled sending only runs on Cloudflare.
 */
import { Router } from 'express';
import { run } from '../lib/db.js';
import { authenticate, requireRole } from '../lib/auth.js';

const isToken = t =>
  typeof t === 'string' && t.length >= 20 && t.length <= 4096 && /^[\w:.\-]+$/.test(t);

const r = Router();
r.use(authenticate);

r.post('/', requireRole('influencer', 'head_influencer'), (req, res) => {
  const { token, platform = 'android' } = req.body || {};
  if (!isToken(token)) return res.status(400).json({ error: 'Not a valid device token' });
  if (platform !== 'android') {
    return res.status(400).json({ error: 'Notifications are only sent to the Android app' });
  }
  run(
    `INSERT INTO device_tokens (user_id, token, platform) VALUES (?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, last_seen_at = datetime('now')`,
    req.user.id, token, platform
  );
  res.json({ ok: true });
});

r.delete('/', (req, res) => {
  const { token } = req.body || {};
  if (!isToken(token)) return res.status(400).json({ error: 'Not a valid device token' });
  const out = run('DELETE FROM device_tokens WHERE token = ? AND user_id = ?', token, req.user.id);
  res.json({ ok: true, removed: out.changes });
});

export default r;
