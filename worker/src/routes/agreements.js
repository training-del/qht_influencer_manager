/**
 * The terms every influencer and head influencer must accept before they get
 * any further than the agreement screen.
 *
 * Ported from server/routes/agreements.js, unchanged in behaviour. These
 * endpoints deliberately do NOT go through the agreement gate — this is the
 * screen someone is sent to *by* that gate, so gating it would be a loop.
 */
import { HttpError, canView } from '../access.js';

const audit = (env, actorId, action, entity, entityId, meta) =>
  env.DB.prepare(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, meta) VALUES (?1,?2,?3,?4,?5)`
  ).bind(actorId ?? null, action, entity ?? null, entityId ?? null,
         meta ? JSON.stringify(meta) : null).run();

const jsonBody = async request => {
  try { return await request.json(); } catch { return {}; }
};

/** The active version, with the clause checklist the screen renders. */
async function current({ env, user, json }) {
  const v = await env.DB.prepare(
    `SELECT * FROM agreement_versions WHERE is_active = 1 ORDER BY id DESC LIMIT 1`
  ).first();
  if (!v) throw new HttpError(404, 'No active agreement version configured');

  return json({
    ...v,
    clauses: JSON.parse(v.clauses_json),
    // shown in the terms themselves, so the amount agreed to is on the page
    tokenAmount: user.token_amount,
    payoutCycle: user.payout_cycle
  });
}

/** What this user already signed — readable at any time, from their profile. */
async function mine({ env, user, json }) {
  const a = await env.DB.prepare(
    `SELECT a.*, v.title, v.summary, v.clauses_json, v.duration_days, v.min_compliance
       FROM agreements a JOIN agreement_versions v ON v.id = a.version_id
      WHERE a.user_id = ?1 ORDER BY a.id DESC LIMIT 1`
  ).bind(user.id).first();
  if (!a) throw new HttpError(404, 'No agreement accepted yet');

  return json({
    ...a,
    clauses: JSON.parse(a.clauses_json),
    accepted_clauses: JSON.parse(a.accepted_clauses)
  });
}

/** Someone else's signed agreement — admin, or a head for their own downline. */
async function ofUser({ env, params, user, json }) {
  const id = Number(params.id);
  if (!(await canView(env.DB, user, id))) throw new HttpError(403, 'Outside your hierarchy');

  const a = await env.DB.prepare(
    `SELECT a.*, v.title, v.clauses_json FROM agreements a
       JOIN agreement_versions v ON v.id = a.version_id
      WHERE a.user_id = ?1 ORDER BY a.id DESC LIMIT 1`
  ).bind(id).first();
  if (!a) throw new HttpError(404, 'Not accepted yet');

  return json({
    ...a,
    clauses: JSON.parse(a.clauses_json),
    accepted_clauses: JSON.parse(a.accepted_clauses)
  });
}

/**
 * Accept. Every clause marked required must be ticked, and the typed signature
 * must match the registered name — a half-ticked form or a wrong name gets no
 * further, whatever the UI allowed.
 */
async function accept({ request, env, user, json }) {
  const { versionId, acceptedClauses, signatureName } = await jsonBody(request);

  const v = await env.DB.prepare('SELECT * FROM agreement_versions WHERE id = ?1')
    .bind(Number(versionId)).first();
  if (!v) throw new HttpError(400, 'Unknown agreement version');

  const clauses = JSON.parse(v.clauses_json);
  const ticked = Array.isArray(acceptedClauses) ? acceptedClauses : [];
  const missing = clauses.filter(c => c.required && !ticked.includes(c.key));
  if (missing.length) throw new HttpError(400, 'All required terms must be accepted');

  if (!signatureName ||
      signatureName.trim().toLowerCase() !== user.full_name.trim().toLowerCase()) {
    throw new HttpError(400,
      `Signature must exactly match your registered name: ${user.full_name}`);
  }

  /* Accepting twice must not write a second record — the first acceptance is
     the one that counts, and its timestamp is what compliance is measured from. */
  const existing = await env.DB.prepare(
    'SELECT id FROM agreements WHERE user_id = ?1 AND version_id = ?2'
  ).bind(user.id, v.id).first();

  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO agreements
        (user_id, version_id, version_label, signature_name, accepted_clauses,
         token_amount_snap, ip_address, user_agent)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
    ).bind(
      user.id, v.id, v.version, signatureName.trim(), JSON.stringify(ticked),
      user.token_amount,
      // Cloudflare puts the real client address here; there is no req.ip
      request.headers.get('cf-connecting-ip') || '',
      request.headers.get('user-agent') || ''
    ).run();
  }

  await env.DB.prepare(`UPDATE users SET status = 'active', updated_at = datetime('now') WHERE id = ?1`)
    .bind(user.id).run();
  await audit(env, user.id, 'accept_agreement', 'agreements', v.id, { version: v.version });

  return json({ ok: true, status: 'active' });
}

/** Admin only: the version history, kept as compliance evidence. */
async function versions({ env, user, json }) {
  if (user.role !== 'admin') throw new HttpError(403, 'Admin only');
  const { results } = await env.DB.prepare(
    `SELECT id, version, title, duration_days, min_compliance, is_active, created_at
       FROM agreement_versions ORDER BY id DESC`
  ).all();
  return json(results);
}

export default [
  ['GET', '/agreement/current', current],
  ['GET', '/agreement/mine', mine],
  ['GET', '/agreement/versions', versions],
  ['GET', '/agreement/user/:id', ofUser],
  ['POST', '/agreement/accept', accept]
];
