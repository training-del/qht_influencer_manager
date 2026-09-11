/**
 * Signing in, reading yourself back, and replacing a temporary password.
 *
 * Ported from server/routes/auth.js. The behaviour is unchanged; what differs
 * is that hashing is async here, and that a successful sign-in quietly upgrades
 * an old, cheaper password hash to the current cost.
 */
import { hashPassword, verifyPassword, issueToken, needsRehash, roundsFor } from '../auth.js';
import { HttpError } from '../access.js';
import { normalisePhone } from '../lib/phone.js';
import { checkPassword } from '../lib/password.js';

const audit = (env, actorId, action, entity, entityId, meta) =>
  env.DB.prepare(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, meta) VALUES (?1,?2,?3,?4,?5)`
  ).bind(actorId ?? null, action, entity ?? null, entityId ?? null,
         meta ? JSON.stringify(meta) : null).run();

const body = async request => {
  try { return await request.json(); } catch { return {}; }
};

/** What the client needs to decide which screen comes next. */
const onboarding = user => ({
  needsAgreement: user.role !== 'admin' && user.status === 'pending_agreement',
  mustChangePassword: !!user.must_change_pw
});

async function login({ request, env, json }) {
  const { identifier, password } = await body(request);
  if (!identifier || !password) {
    throw new HttpError(400, 'Phone/email and password are required');
  }

  // "+91 98765 43210", "9198765 43210" and the bare 10 digits are one account
  const asPhone = normalisePhone(identifier);
  const user = await env.DB.prepare(
    `SELECT * FROM users WHERE phone = ?1 OR phone = ?2 OR lower(email) = lower(?3)`
  ).bind(String(identifier).trim(), asPhone, String(identifier)).first();

  /* One message for "no such account" and "wrong password" alike: saying which
     it was would let anyone check whether a number is registered. */
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new HttpError(401, 'Invalid credentials');
  }
  if (user.status === 'suspended') {
    throw new HttpError(403, 'Account suspended. Contact QHT admin.');
  }

  /* The one place a plaintext password is available, so the one place an old
     hash can be upgraded. Moving to the paid plan and raising the cost then
     needs nothing else: everyone is re-hashed as they sign in. */
  const rounds = roundsFor(env);
  if (needsRehash(user.password_hash, rounds)) {
    const upgraded = await hashPassword(password, rounds);
    await env.DB.prepare('UPDATE users SET password_hash = ?1 WHERE id = ?2')
      .bind(upgraded, user.id).run();
  }

  await audit(env, user.id, 'login', 'users', user.id);
  delete user.password_hash;

  return json({ token: await issueToken(user, env.SESSION_SECRET), user, ...onboarding(user) });
}

async function me({ env, user, json }) {
  const parent = user.parent_id
    ? await env.DB.prepare('SELECT id, full_name, role FROM users WHERE id = ?1')
        .bind(user.parent_id).first()
    : null;
  return json({ user, registeredBy: parent, ...onboarding(user) });
}

async function changePassword({ request, env, user, json }) {
  const { currentPassword, newPassword } = await body(request);

  const strength = checkPassword(newPassword);
  if (!strength.ok) throw new HttpError(400, strength.error);

  const full = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?1')
    .bind(user.id).first();
  if (!(await verifyPassword(currentPassword || '', full.password_hash))) {
    throw new HttpError(400, 'Current password is incorrect');
  }
  if (currentPassword === newPassword) {
    throw new HttpError(400, 'Choose a password different from the temporary one');
  }

  await env.DB.prepare(
    `UPDATE users SET password_hash = ?1, must_change_pw = 0, updated_at = datetime('now')
     WHERE id = ?2`
  ).bind(await hashPassword(newPassword, roundsFor(env)), user.id).run();

  await audit(env, user.id, 'change_password', 'users', user.id);
  return json({ ok: true });
}

export default [
  ['POST', '/auth/login', login, { auth: false }],
  ['GET', '/auth/me', me],
  ['POST', '/auth/change-password', changePassword]
];
