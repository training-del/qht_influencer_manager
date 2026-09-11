/**
 * The daily proof photo: sending one, reviewing one, and reading a calendar.
 *
 * Ported from server/routes/submissions.js. The one real change is where the
 * photo goes — R2 instead of the local disk — and it is still never public:
 * see the media route in src/index.js, which is what serves it back.
 */
import {
  HttpError, assertRole, assertAgreementAccepted, assertPasswordSet,
  assertNotSelfReview, visibleUserIds, canView
} from '../access.js';
import { complianceFor } from '../lib/compliance.js';
import { discard } from '../lib/trash.js';
import { todayIST } from '../lib/time.js';

const audit = (env, actorId, action, entity, entityId, meta) =>
  env.DB.prepare(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, meta) VALUES (?1,?2,?3,?4,?5)`
  ).bind(actorId ?? null, action, entity ?? null, entityId ?? null,
         meta ? JSON.stringify(meta) : null).run();

const jsonBody = async request => {
  try { return await request.json(); } catch { return {}; }
};

const gate = user => { assertAgreementAccepted(user); assertPasswordSet(user); };
const today = () => todayIST();     // the Worker's clock is UTC; the programme's day is IST
const placeholders = (n, from = 1) =>
  Array.from({ length: n }, (_, i) => `?${i + from}`).join(',');

/* --------------------- send today's proof (influencer or head) --------------------- */
/**
 * One submission per calendar day; sending again the same day replaces the
 * photo and puts it back in the queue. Head influencers sign the same terms —
 * daily consumption, daily photo — so they send proof too. Only the admin has
 * none to give.
 */
async function submit({ request, env, user, json }) {
  gate(user);
  assertRole(user, 'influencer', 'head_influencer');

  const form = await request.formData();
  const photo = form.get('photo');
  if (!photo || typeof photo === 'string' || !photo.size) {
    throw new HttpError(400, 'A proof photo is required');
  }
  if (!/^image\//.test(photo.type)) throw new HttpError(400, 'Only image files are accepted');
  if (photo.size > 10 * 1024 * 1024) throw new HttpError(413, 'Photo must be under 10 MB');

  const asked = String(form.get('date') || '');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : today();
  if (date > today()) throw new HttpError(400, 'Cannot submit for a future date');

  const note = form.get('note') ? String(form.get('note')) : null;

  const existing = await env.DB.prepare(
    'SELECT id, status, photo_path FROM daily_submissions WHERE user_id = ?1 AND submission_date = ?2'
  ).bind(user.id, date).first();

  /* An approved day is settled — payouts are calculated from it, so it cannot
     be quietly swapped for a different photo afterwards. */
  if (existing?.status === 'approved') {
    throw new HttpError(409, 'This day is already approved and cannot be changed');
  }

  /* Random name, not the uploaded one: object keys should reveal nothing and be
     impossible to guess from someone else's. */
  const ext = (photo.name?.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0].toLowerCase();
  const key = `proofs/${crypto.randomUUID()}${ext}`;
  await env.PHOTOS.put(key, photo.stream(), { httpMetadata: { contentType: photo.type } });

  if (existing) {
    await env.DB.prepare(
      `UPDATE daily_submissions
          SET photo_path = ?1, note = ?2, captured_at = datetime('now'),
              status = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL
        WHERE id = ?3`
    ).bind(key, note, existing.id).run();

    // only after the row points at the new photo, or a failure would lose both;
    // the old one goes to trash, recoverable for 30 days
    await discard(env, existing.photo_path, 'replaced proof');
    await audit(env, user.id, 'resubmit_proof', 'daily_submissions', existing.id, { date });
    return json({ ok: true, replaced: true, id: existing.id, date });
  }

  const info = await env.DB.prepare(
    'INSERT INTO daily_submissions (user_id, submission_date, photo_path, note) VALUES (?1,?2,?3,?4)'
  ).bind(user.id, date, key, note).run();

  await audit(env, user.id, 'submit_proof', 'daily_submissions', info.meta.last_row_id, { date });
  return json({ ok: true, id: info.meta.last_row_id, date }, 201);
}

/* ------------------------- your own history and calendar ------------------------- */
async function mine({ env, url, user, json }) {
  gate(user);
  const asked = url.searchParams.get('month') || '';
  const month = /^\d{4}-\d{2}$/.test(asked) ? asked : today().slice(0, 7);

  const { results } = await env.DB.prepare(
    `SELECT id, submission_date, photo_path, note, status, review_note, captured_at
       FROM daily_submissions
      WHERE user_id = ?1 AND substr(submission_date, 1, 7) = ?2
      ORDER BY submission_date DESC`
  ).bind(user.id, month).all();

  return json({
    month,
    submissions: results,
    compliance: await complianceFor(env.DB, user.id),
    today: today()
  });
}

/* --------------------- the review queue across the team --------------------- */
async function queue({ env, url, user, json }) {
  gate(user);
  assertRole(user, 'admin', 'head_influencer');

  const ids = await visibleUserIds(env.DB, user);
  if (!ids.length) return json([]);

  const params = [...ids];
  const filters = [`s.user_id IN (${placeholders(ids.length)})`];
  const add = (clause, value) => { params.push(value); filters.push(clause(params.length)); };

  const q = url.searchParams;
  if (q.get('status')) add(n => `s.status = ?${n}`, q.get('status'));
  if (q.get('date')) add(n => `s.submission_date = ?${n}`, q.get('date'));
  if (/^\d{4}-\d{2}$/.test(q.get('month') || '')) {
    add(n => `substr(s.submission_date, 1, 7) = ?${n}`, q.get('month'));
  }
  if (q.get('userId')) add(n => `s.user_id = ?${n}`, Number(q.get('userId')));

  params.push(Number(q.get('limit')) || 200);

  const { results } = await env.DB.prepare(
    `SELECT s.*, u.full_name, u.phone, u.role, p.full_name AS parent_name
       FROM daily_submissions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN users p ON p.id = u.parent_id
      WHERE ${filters.join(' AND ')}
      ORDER BY s.submission_date DESC, s.id DESC
      LIMIT ?${params.length}`
  ).bind(...params).all();

  return json(results);
}

/* ------------------------------- review one ------------------------------- */
/**
 * Approve, reject or flag. A head influencer reviews their own downline, the
 * admin reviews everyone, and nobody reviews their own photo — signing off on
 * your own evidence is not a review.
 */
async function review({ request, env, params, user, json }) {
  gate(user);
  assertRole(user, 'admin', 'head_influencer');

  const b = await jsonBody(request);
  if (!['approved', 'rejected', 'flagged', 'pending'].includes(b.status)) {
    throw new HttpError(400, 'status must be approved, rejected, flagged or pending');
  }

  const sub = await env.DB.prepare('SELECT * FROM daily_submissions WHERE id = ?1')
    .bind(Number(params.id)).first();
  if (!sub) throw new HttpError(404, 'Not found');

  assertNotSelfReview(user, sub);
  if (!(await canView(env.DB, user, sub.user_id))) {
    throw new HttpError(403, 'Outside your hierarchy');
  }

  await env.DB.prepare(
    `UPDATE daily_submissions
        SET status = ?1, reviewed_by = ?2, reviewed_at = datetime('now'), review_note = ?3
      WHERE id = ?4`
  ).bind(b.status, user.id, b.reviewNote || null, sub.id).run();

  await audit(env, user.id, 'review_submission', 'daily_submissions', sub.id, { status: b.status });
  return json({ ok: true });
}

/* ------------------------- one influencer's calendar ------------------------- */
async function ofUser({ env, url, params, user, json }) {
  gate(user);
  assertRole(user, 'admin', 'head_influencer');

  const id = Number(params.id);
  if (!(await canView(env.DB, user, id))) throw new HttpError(403, 'Outside your hierarchy');

  const asked = url.searchParams.get('month') || '';
  const month = /^\d{4}-\d{2}$/.test(asked) ? asked : today().slice(0, 7);

  const { results } = await env.DB.prepare(
    `SELECT id, submission_date, photo_path, note, status, review_note
       FROM daily_submissions
      WHERE user_id = ?1 AND substr(submission_date, 1, 7) = ?2
      ORDER BY submission_date DESC`
  ).bind(id, month).all();

  return json({ month, submissions: results, compliance: await complianceFor(env.DB, id) });
}

export default [
  ['POST', '/submissions', submit],
  ['GET', '/submissions/mine', mine],
  ['GET', '/submissions', queue],
  ['PATCH', '/submissions/:id/review', review],
  ['GET', '/submissions/user/:id', ofUser]
];
