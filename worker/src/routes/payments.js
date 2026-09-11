/**
 * Payouts: what someone is owed, what has been released, and the admin's
 * controls for raising and releasing one.
 *
 * Ported from server/routes/payments.js, unchanged in behaviour.
 */
import {
  HttpError, assertRole, assertAgreementAccepted, assertPasswordSet,
  visibleUserIds, canView
} from '../access.js';
import { complianceFor } from '../lib/compliance.js';

const audit = (env, actorId, action, entity, entityId, meta) =>
  env.DB.prepare(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, meta) VALUES (?1,?2,?3,?4,?5)`
  ).bind(actorId ?? null, action, entity ?? null, entityId ?? null,
         meta ? JSON.stringify(meta) : null).run();

const jsonBody = async request => {
  try { return await request.json(); } catch { return {}; }
};

const gate = user => { assertAgreementAccepted(user); assertPasswordSet(user); };
const placeholders = n => Array.from({ length: n }, (_, i) => `?${i + 1}`).join(',');

/* ---------------------------- your own payouts ---------------------------- */
async function mine({ env, user, json }) {
  gate(user);
  const { results } = await env.DB.prepare(
    `SELECT id, period_start, period_end, amount, compliance_pct, status,
            released_at, reference_no, note
       FROM payments WHERE user_id = ?1 ORDER BY period_start DESC`
  ).bind(user.id).all();

  return json({
    tokenAmount: user.token_amount,
    payoutCycle: user.payout_cycle,
    nextPayoutDate: user.next_payout_date,
    compliance: await complianceFor(env.DB, user.id),
    payments: results
  });
}

/* --------------------------- the team's payouts --------------------------- */
async function list({ env, url, user, json }) {
  gate(user);
  assertRole(user, 'admin', 'head_influencer');

  const ids = await visibleUserIds(env.DB, user);
  if (!ids.length) return json([]);

  const params = [...ids];
  const filters = [`p.user_id IN (${placeholders(ids.length)})`];
  const status = url.searchParams.get('status');
  if (status) { params.push(status); filters.push(`p.status = ?${params.length}`); }

  /* Bank details come back here because this is the screen someone pays from.
     visibleUserIds already limits it to their own downline. */
  const { results } = await env.DB.prepare(
    `SELECT p.*, u.full_name, u.phone, u.role, u.upi_id, u.bank_account_no
       FROM payments p JOIN users u ON u.id = p.user_id
      WHERE ${filters.join(' AND ')}
      ORDER BY p.status = 'released', p.period_end DESC`
  ).bind(...params).all();

  return json(results);
}

/* ------------------------------ raise a payout ------------------------------ */
async function create({ request, env, user, json }) {
  gate(user);
  assertRole(user, 'admin');

  const b = await jsonBody(request);
  const userId = Number(b.userId);
  if (!(await canView(env.DB, user, userId))) throw new HttpError(400, 'Unknown user');

  const u = await env.DB.prepare('SELECT id, token_amount FROM users WHERE id = ?1')
    .bind(userId).first();
  if (!u) throw new HttpError(404, 'Not found');
  if (!b.periodStart || !b.periodEnd) {
    throw new HttpError(400, 'periodStart and periodEnd are required');
  }

  /* The compliance figure is stamped onto the payment at the moment it is
     raised, so a later photo cannot change what a past period was paid on. */
  const c = await complianceFor(env.DB, userId);
  const amount = Number.isFinite(Number(b.amount)) && b.amount !== ''
    ? Number(b.amount) : u.token_amount;

  const info = await env.DB.prepare(
    `INSERT INTO payments (user_id, period_start, period_end, amount, compliance_pct, status, note)
     VALUES (?1,?2,?3,?4,?5,?6,?7)`
  ).bind(
    userId, b.periodStart, b.periodEnd, amount, c.compliancePct,
    ['pending', 'on_hold', 'released'].includes(b.status) ? b.status : 'pending',
    b.note || null
  ).run();

  await audit(env, user.id, 'create_payment', 'payments', info.meta.last_row_id, { userId, amount });
  return json({ ok: true, id: info.meta.last_row_id, amount, compliancePct: c.compliancePct }, 201);
}

/* --------------------------- release / hold a payout --------------------------- */
async function update({ request, env, params, user, json }) {
  gate(user);
  assertRole(user, 'admin');

  const p = await env.DB.prepare('SELECT * FROM payments WHERE id = ?1')
    .bind(Number(params.id)).first();
  if (!p) throw new HttpError(404, 'Not found');

  const b = await jsonBody(request);
  if (!['pending', 'on_hold', 'released'].includes(b.status)) {
    throw new HttpError(400, 'status must be pending, on_hold or released');
  }

  await env.DB.prepare(
    `UPDATE payments
        SET status = ?1,
            released_at = CASE WHEN ?1 = 'released' THEN datetime('now') ELSE NULL END,
            released_by = CASE WHEN ?1 = 'released' THEN ?2 ELSE NULL END,
            reference_no = COALESCE(?3, reference_no),
            note = COALESCE(?4, note)
      WHERE id = ?5`
  ).bind(b.status, user.id, b.referenceNo || null, b.note || null, p.id).run();

  await audit(env, user.id, 'update_payment', 'payments', p.id, { status: b.status });
  return json({ ok: true });
}

export default [
  ['GET', '/payments/mine', mine],
  ['GET', '/payments', list],
  ['POST', '/payments', create],
  ['PATCH', '/payments/:id', update]
];
