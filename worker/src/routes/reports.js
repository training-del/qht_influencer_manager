/**
 * The dashboard figures and the CSV export.
 *
 * Ported from server/routes/reports.js, unchanged in behaviour. Both endpoints
 * are built from the same scoped roster, so the export can never show someone
 * the summary did not count.
 */
import {
  assertRole, assertAgreementAccepted, assertPasswordSet, visibleUserIds
} from '../access.js';
import { complianceFor } from '../lib/compliance.js';
import { todayIST } from '../lib/time.js';

const gate = user => { assertAgreementAccepted(user); assertPasswordSet(user); };
const today = () => todayIST();
const placeholders = (n, from = 1) =>
  Array.from({ length: n }, (_, i) => `?${i + from}`).join(',');

/** The people this viewer may count: everyone, or their own downline. */
async function roster(db, viewer) {
  const ids = await visibleUserIds(db, viewer);
  if (!ids.length) return [];
  const { results } = await db.prepare(
    `SELECT u.id, u.role, u.full_name, u.phone, u.status, u.token_amount, u.created_at,
            p.full_name AS parent_name
       FROM users u LEFT JOIN users p ON p.id = u.parent_id
      WHERE u.id IN (${placeholders(ids.length)}) ORDER BY u.role, u.full_name`
  ).bind(...ids).all();
  return results;
}

/* --------------------------------- the KPIs --------------------------------- */
async function summary({ env, user, json }) {
  gate(user);
  assertRole(user, 'admin', 'head_influencer');

  const people = await roster(env.DB, user);
  const influencers = people.filter(u => u.role === 'influencer');

  /* Compliance only means something once the agreement is signed. Someone still
     on pending_agreement has not started, so counting them would drag every
     average down for a reason that is not their fault. */
  const active = influencers.filter(u => u.status === 'active');
  const withCompliance = [];
  for (const u of active) {
    withCompliance.push({ ...u, compliance: await complianceFor(env.DB, u.id) });
  }

  const ids = people.map(u => u.id);
  const zero = { total: 0, released: 0, outstanding: 0 };

  let pendingReviews = 0, submittedToday = 0, payments = zero;
  if (ids.length) {
    const ph = placeholders(ids.length);
    pendingReviews = (await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM daily_submissions WHERE status = 'pending' AND user_id IN (${ph})`
    ).bind(...ids).first()).n;

    submittedToday = (await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM daily_submissions
        WHERE submission_date = ?${ids.length + 1} AND user_id IN (${ph})`
    ).bind(...ids, today()).first()).n;

    payments = await env.DB.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total,
              COALESCE(SUM(CASE WHEN status = 'released' THEN amount ELSE 0 END), 0) AS released,
              COALESCE(SUM(CASE WHEN status <> 'released' THEN amount ELSE 0 END), 0) AS outstanding
         FROM payments WHERE user_id IN (${ph})`
    ).bind(...ids).first();
  }

  const avg = withCompliance.length
    ? Math.round((withCompliance.reduce((s, u) => s + u.compliance.compliancePct, 0)
        / withCompliance.length) * 10) / 10
    : 0;

  return json({
    scope: user.role === 'admin' ? 'all' : 'my team',
    headInfluencers: people.filter(u => u.role === 'head_influencer').length,
    influencers: influencers.length,
    activeInfluencers: active.length,
    pendingAgreement: people.filter(u => u.status === 'pending_agreement').length,
    suspended: people.filter(u => u.status === 'suspended').length,
    submittedToday,
    awaitingSubmissionToday: withCompliance.filter(u => !u.compliance.submittedToday).length,
    pendingReviews,
    avgCompliance: avg,
    totalMissedDays: withCompliance.reduce((s, u) => s + u.compliance.missedDays, 0),
    payments,
    lowCompliance: withCompliance
      .filter(u => u.compliance.compliancePct < 80)
      .sort((a, b) => a.compliance.compliancePct - b.compliance.compliancePct)
      .slice(0, 10)
      .map(u => ({
        id: u.id, name: u.full_name,
        pct: u.compliance.compliancePct, missed: u.compliance.missedDays
      }))
  });
}

/* -------------------------------- CSV export -------------------------------- */
async function exportCsv({ env, user }) {
  gate(user);
  assertRole(user, 'admin', 'head_influencer');

  const people = await roster(env.DB, user);
  const rows = [];

  for (const u of people) {
    const c = u.role === 'influencer' ? await complianceFor(env.DB, u.id) : null;
    const pay = await env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN status = 'released' THEN amount ELSE 0 END), 0) AS released,
              COALESCE(SUM(CASE WHEN status <> 'released' THEN amount ELSE 0 END), 0) AS pending
         FROM payments WHERE user_id = ?1`
    ).bind(u.id).first();

    rows.push({
      id: u.id,
      name: u.full_name,
      role: u.role,
      registered_by: u.parent_name || 'QHT Admin',
      status: u.status,
      phone: u.phone,
      token_amount: u.token_amount,
      days_active: c?.daysActive ?? '',
      submitted: c?.submitted ?? '',
      approved: c?.approved ?? '',
      rejected: c?.rejected ?? '',
      missed_days: c?.missedDays ?? '',
      compliance_pct: c?.compliancePct ?? '',
      last_submission: c?.lastSubmission ?? '',
      paid_released: pay.released,
      paid_pending: pay.pending
    });
  }

  const header = Object.keys(rows[0] || { id: '', name: '', role: '' });
  // every field quoted, embedded quotes doubled — a name with a comma in it
  // must not shift every column after it
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [header.join(','), ...rows.map(r => header.map(h => esc(r[h])).join(','))].join('\r\n');

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="qht-compliance-${today()}.csv"`
    }
  });
}

export default [
  ['GET', '/reports/summary', summary],
  ['GET', '/reports/export.csv', exportCsv]
];
