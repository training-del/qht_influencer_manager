/**
 * The QHT Influencer Manager API, as a Cloudflare Worker.
 *
 * This replaces the Express server. The routing is deliberately tiny — the app
 * has about thirty endpoints and no need for a framework, and every dependency
 * is one more thing to keep working inside the Workers runtime.
 *
 * The Worker is the only thing bound to D1 and to the photo bucket, so it is
 * also the security boundary: see src/access.js.
 */
import { HttpError, canView } from './access.js';
import { readToken } from './auth.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import agreementRoutes from './routes/agreements.js';
import submissionRoutes from './routes/submissions.js';
import paymentRoutes from './routes/payments.js';
import reportRoutes from './routes/reports.js';
import deviceRoutes from './routes/devices.js';

/* Routes are [method, pattern, handler]. A pattern segment starting with ":"
   captures — "/users/:id/impact" gives { id }.
   Matching runs in order, so a literal like /users/heads must be listed before
   /users/:id or it would be read as an id. */
const ROUTES = [
  ...authRoutes, ...userRoutes, ...agreementRoutes,
  ...submissionRoutes, ...paymentRoutes, ...reportRoutes, ...deviceRoutes
];

function match(method, path) {
  const parts = path.split('/').filter(Boolean);
  for (const [m, pattern, handler, opts] of ROUTES) {
    if (m !== method) continue;
    const want = pattern.split('/').filter(Boolean);
    if (want.length !== parts.length) continue;

    const params = {};
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      if (want[i].startsWith(':')) params[want[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (want[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { handler, params, opts: opts || {} };
  }
  return null;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' }
});

/* ----------------------------------- CORS ----------------------------------- */
/**
 * The pages come from Cloudflare Pages and the API from here, so every request
 * the app makes is cross-origin and needs these headers.
 *
 * An allowlist, not "*". This API answers with people's bank details, ID
 * documents and medical proof photos; the browser should only hand a response
 * to a page we actually published. Set ALLOWED_ORIGINS as a comma-separated
 * list on the Worker; with nothing set, only same-origin requests work.
 */
const allowedOrigins = env =>
  String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins(env).includes(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    // the response differs per origin, so a cache must not share one for all
    'vary': 'Origin',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'Authorization,Content-Type',
    'access-control-max-age': '86400'
  };
}

/** Adds the CORS headers to a response that has already been built. */
function withCors(response, cors) {
  if (!cors) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Loads the signed-in user from the bearer token.
 * The token carries the id and role, but everything else is read fresh — a
 * suspended account or a changed role must take effect immediately, not
 * whenever the token happens to expire.
 */
async function currentUser(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && await readToken(token, env.SESSION_SECRET);
  if (!payload) return null;

  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1')
    .bind(payload.id).first();
  if (!user) return null;
  delete user.password_hash;
  return user;
}

/**
 * Serves a photo out of R2.
 *
 * The bucket is private and stays that way. A photo is someone's medical proof,
 * so it is readable by its owner and by whoever is above them — the same rule
 * the rest of the API uses. Anonymous requests get 401, outsiders get 403, and
 * a guessed object key gets nowhere because nothing is served that is not
 * referenced by a row the caller is allowed to see.
 */
async function media(request, env, user, kind, file) {
  if (!['proofs', 'idproofs'].includes(kind) || !/^[\w.\-]+$/.test(file)) {
    return json({ error: 'Bad path' }, 400);
  }

  const key = `${kind}/${file}`;
  const owner = kind === 'proofs'
    ? await env.DB.prepare('SELECT user_id AS id FROM daily_submissions WHERE photo_path = ?1')
        .bind(key).first()
    : await env.DB.prepare('SELECT id FROM users WHERE id_proof_file = ?1').bind(key).first();

  if (!owner) return json({ error: 'Not found' }, 404);
  if (owner.id !== user.id && !(await canView(env.DB, user, owner.id))) {
    return json({ error: 'Not permitted' }, 403);
  }

  const object = await env.PHOTOS.get(key);
  if (!object) return json({ error: 'Not found' }, 404);

  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
      // private: a shared cache must never hold someone else's proof photo
      'cache-control': 'private, max-age=3600'
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    /* A bearer token and a JSON content type both make the browser ask first.
       An unrecognised origin gets no headers back, which is the refusal. */
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    }

    const reply = await this.route(request, env, ctx, url);
    return withCors(reply, cors);
  },

  async route(request, env, ctx, url) {
    /* Photos: authenticated, like everything else, but not under /api because
       the front end already builds these URLs as /media/<kind>/<file>. */
    if (url.pathname.startsWith('/media/')) {
      const [, , kind, file] = url.pathname.split('/');
      const user = await currentUser(request, env);
      if (!user) return json({ error: 'Not signed in' }, 401);
      try {
        return await media(request, env, user, kind, file);
      } catch (err) {
        console.error(err);
        return json({ error: 'Server error' }, 500);
      }
    }

    // the API lives under /api, so Pages can serve the front end from the root
    if (!url.pathname.startsWith('/api/')) {
      return json({ error: 'Not found' }, 404);
    }
    const path = url.pathname.slice(4);

    if (path === '/health') {
      return json({ ok: true, service: 'qht-influencer-manager' });
    }

    const route = match(request.method, path);
    if (!route) return json({ error: 'Not found' }, 404);

    try {
      let user = null;
      if (route.opts.auth !== false) {
        user = await currentUser(request, env);
        if (!user) return json({ error: 'Not signed in' }, 401);
      }
      return await route.handler({ request, env, ctx, url, params: route.params, user, json });
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
      }
      console.error(err);
      return json({ error: 'Server error' }, 500);
    }
  }
};
