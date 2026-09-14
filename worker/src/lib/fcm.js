/**
 * Sending to the Android app through Firebase Cloud Messaging (HTTP v1 API).
 *
 * FCM v1 takes an OAuth access token from a Google service account. There is
 * no Google SDK in a Worker, so the sign-in is done by hand: a JWT signed with
 * the service account's RSA key (WebCrypto), exchanged at Google's token URL.
 *
 * The service account JSON is the Worker secret FCM_SERVICE_ACCOUNT. It is a
 * password to send notifications as QHT — never commit it, never paste it in
 * chat:  npx wrangler secret put FCM_SERVICE_ACCOUNT -c worker/wrangler.cron.toml
 */
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const fcmSendUrl = projectId => `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

const b64url = buf => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlJson = obj => b64url(new TextEncoder().encode(JSON.stringify(obj)));

function pemToDer(pem) {
  const body = String(pem).replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** The service account from the secret, or null when it is not set. */
export function readServiceAccount(env) {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  let sa;
  try { sa = JSON.parse(env.FCM_SERVICE_ACCOUNT); } catch {
    throw new Error('FCM_SERVICE_ACCOUNT is not valid JSON');
  }
  if (!sa.project_id || !sa.client_email || !sa.private_key) {
    throw new Error('FCM_SERVICE_ACCOUNT is missing project_id, client_email or private_key');
  }
  return sa;
}

/** The signed assertion Google exchanges for an access token. */
export async function signAssertion(sa, now = Math.floor(Date.now() / 1000)) {
  const unsigned = `${b64urlJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlJson({
    iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600
  })}`;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}

/** One access token per run; it is good for an hour. */
export async function getAccessToken(sa, fetchImpl = fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: await signAssertion(sa)
    }).toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Google sign-in for FCM failed (${res.status} ${data.error || ''})`.trim());
  }
  return data.access_token;
}

/**
 * Sends one notification to one app install.
 * @returns {Promise<'sent'|'gone'|'retry'>}
 *   gone  — the token is dead (app uninstalled, token rotated): delete it
 *   retry — Google had a problem; try again on the next run
 */
export async function sendToDevice({ projectId, bearer, token, title, body, data }, fetchImpl = fetch) {
  const res = await fetchImpl(fcmSendUrl(projectId), {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        data,                                        // string values only
        android: { priority: 'HIGH', notification: { channel_id: 'reminders' } }
      }
    })
  });
  if (res.ok) return 'sent';

  const err = (await res.json().catch(() => ({})))?.error || {};
  const code = (err.details || []).map(d => d.errorCode).find(Boolean);
  /* Only a verdict about the token itself removes it. A 400 for anything else
     (a malformed message would be our bug) must not wipe every device. */
  if (res.status === 404 || code === 'UNREGISTERED') return 'gone';
  if (res.status === 400 && /registration token/i.test(err.message || '')) return 'gone';
  return 'retry';
}
