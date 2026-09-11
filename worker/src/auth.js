/**
 * Passwords and session tokens, on Workers.
 *
 * The Express version used node:crypto scrypt. Workers has no Node crypto —
 * only WebCrypto — and WebCrypto has no scrypt, so passwords are hashed with
 * PBKDF2-SHA256 instead. Every stored hash carries its own scheme, salt and
 * iteration count, so the cost can be raised later without invalidating
 * anyone's password: an old hash still verifies with the numbers it was made
 * with, and gets re-hashed at the next successful sign-in.
 */

const enc = new TextEncoder();

/**
 * PBKDF2 rounds.
 *
 * OWASP's figure for PBKDF2-SHA256 is 600,000, which costs roughly 100ms of
 * CPU. The Workers *free* plan allows about 10ms per request, so that number
 * cannot be used there — a sign-in would be killed part-way through the hash.
 *
 * 25,000 measures around 4-5ms, leaving room for the rest of the request. It is
 * well below the recommendation, and is a deliberate trade for staying on the
 * free plan. Raise it by setting PBKDF2_ROUNDS on the Worker after moving to
 * the paid plan; nothing else has to change, because each stored hash records
 * the cost it was made with and gets upgraded on its owner's next sign-in.
 */
export const FREE_PLAN_ROUNDS = 25_000;
export const RECOMMENDED_ROUNDS = 600_000;

export const roundsFor = env =>
  Number(env?.PBKDF2_ROUNDS) || FREE_PLAN_ROUNDS;

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = s => new Uint8Array(s.match(/.{2}/g).map(b => parseInt(b, 16)));

async function derive(password, salt, rounds) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: rounds, hash: 'SHA-256' }, key, 256
  );
  return new Uint8Array(bits);
}

/** @returns {Promise<string>} `pbkdf2$<rounds>$<salt>$<hash>` */
export async function hashPassword(password, rounds = FREE_PLAN_ROUNDS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const out = await derive(password, salt, rounds);
  return `pbkdf2$${rounds}$${hex(salt)}$${hex(out)}`;
}

/** Constant-time compare — a length check alone leaks nothing, a loop would. */
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password, stored) {
  const [scheme, rounds, salt, expected] = String(stored ?? '').split('$');
  if (scheme !== 'pbkdf2' || !rounds || !salt || !expected) return false;
  const got = await derive(password, unhex(salt), Number(rounds));
  return sameBytes(got, unhex(expected));
}

/**
 * True when a hash was made more cheaply than the current setting — which is
 * what makes moving to the paid plan painless: raise PBKDF2_ROUNDS and every
 * password is quietly re-hashed at its owner's next successful sign-in.
 */
export const needsRehash = (stored, rounds = FREE_PLAN_ROUNDS) =>
  Number(String(stored ?? '').split('$')[1]) < rounds;

/* ---------------------------- session tokens ---------------------------- */
/* Same shape as the Express version: base64url payload, dot, HMAC signature.
   Stateless, so no session table and no database read to check one. */

const TTL_MS = 12 * 60 * 60 * 1000;

const b64url = bytes => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = s => Uint8Array.from(
  atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)
);

async function signingKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
}

async function sign(body, secret) {
  const mac = await crypto.subtle.sign('HMAC', await signingKey(secret), enc.encode(body));
  return b64url(new Uint8Array(mac));
}

export async function issueToken(user, secret) {
  const body = b64url(enc.encode(JSON.stringify({
    id: user.id, role: user.role, exp: Date.now() + TTL_MS
  })));
  return `${body}.${await sign(body, secret)}`;
}

/** @returns the payload, or null if the token is forged, tampered with or expired */
export async function readToken(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = await sign(body, secret);
  if (!sameBytes(enc.encode(sig), enc.encode(expected))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}
