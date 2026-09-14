/**
 * The phones that get notifications.
 *
 * The Android app registers its Firebase token here after someone signs in,
 * and removes it when they sign out. Everyone can: influencers (the 7 PM
 * reminder, a rejected photo), head influencers (review summaries, their
 * team's new photos) and the admin (head influencers' new photos). The sending
 * is done by the scheduled Worker — see src/cron.js.
 */
import { HttpError, assertRole } from '../access.js';

const jsonBody = async request => {
  try { return await request.json(); } catch { return {}; }
};

/* FCM tokens are long, URL-safe strings. Anything else is not one. */
const isToken = t =>
  typeof t === 'string' && t.length >= 20 && t.length <= 4096 && /^[\w:.\-]+$/.test(t);

async function register({ request, env, user, json }) {
  // the admin too: a head influencer's new photo is theirs to review
  assertRole(user, 'influencer', 'head_influencer', 'admin');
  const { token, platform = 'android' } = await jsonBody(request);
  if (!isToken(token)) throw new HttpError(400, 'Not a valid device token');
  if (platform !== 'android') throw new HttpError(400, 'Notifications are only sent to the Android app');

  /* A token belongs to an install, not a person: when someone else signs in on
     the same phone, the reminders follow the person now using it. */
  await env.DB.prepare(
    `INSERT INTO device_tokens (user_id, token, platform) VALUES (?1, ?2, ?3)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, last_seen_at = datetime('now')`
  ).bind(user.id, token, platform).run();

  return json({ ok: true });
}

async function unregister({ request, env, user, json }) {
  const { token } = await jsonBody(request);
  if (!isToken(token)) throw new HttpError(400, 'Not a valid device token');

  // only your own — knowing a token is not a way to silence someone else's phone
  const r = await env.DB.prepare('DELETE FROM device_tokens WHERE token = ?1 AND user_id = ?2')
    .bind(token, user.id).run();
  return json({ ok: true, removed: r.meta.changes });
}

export default [
  ['POST', '/devices', register],
  ['DELETE', '/devices', unregister]
];
