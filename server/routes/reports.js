import { Router } from 'express';
import { get, all, visibleUserIds } from '../lib/db.js';
import { authenticate, requireRole, requireAgreement, requirePasswordSet } from '../lib/auth.js';
import { complianceFor } from '../lib/compliance.js';

const r = Router();
r.use(authenticate, requireAgreement, requirePasswordSet, requireRole('admin', 'head_influencer'));

const today = () => new Date().toLocaleDateString('en-CA');

/** Scoped roster with compliance rolled up — the basis for both summary and export. */
function roster(viewer) {
  const ids = visibleUserIds(viewer);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return all(
    `SELECT u.id, u.role, u.full_name, u.phone, u.status, u.token_amount, u.created_at,
            p.full_name AS parent_name
       FROM users u LEFT JOIN users p ON p.id = u.parent_id
      WHERE u.id IN (${placeholders}) ORDER BY u.role, u.full_name`, ...ids);
}

/* --------------------------------- dashboard KPIs --------------------------------- */
r.get('/summary', (req, res) => {
  const people = roster(req.user);
  const influencers = people.filter(u => u.role === 'influencer');

  // Compliance is only meaningful once the agreement is accepted — someone still
  // on 'pending_agreement' has not started, so they must not drag the averages.
  const withCompliance = influencers
    .filter(u => u.status === 'active')
    .map(u => ({ ...u, compliance: complianceFor(u.id) }));

  const ids = people.map(u => u.id);
  const ph = ids.length ? ids.map(() => '?').join(',') : 'NULL';
  const pendingReviews = ids.length
    ? get(`SELECT COUNT(*) AS n FROM daily_submissions WHERE status = 'pending' AND user_id IN (${ph})`, ...ids).n
    : 0;
  const submittedToday = ids.length
    ? get(`SELECT COUNT(*) AS n FROM daily_submissions WHERE submission_date = ? AND user_id IN (${ph})`, today(), ...ids).n
    : 0;
  const payments = ids.length
    ? get(`SELECT COALESCE(SUM(amount), 0) AS total,
                  COALESCE(SUM(CASE WHEN status = 'released' THEN amount ELSE 0 END), 0) AS released,
                  COALESCE(SUM(CASE WHEN status <> 'released' THEN amount ELSE 0 END), 0) AS outstanding
             FROM payments WHERE user_id IN (${ph})`, ...ids)
    : { total: 0, released: 0, outstanding: 0 };

  const avg = withCompliance.length
    ? Math.round((withCompliance.reduce((s, u) => s + u.compliance.compliancePct, 0) / withCompliance.length) * 10) / 10
    : 0;

  res.json({
    scope: req.user.role === 'admin' ? 'all' : 'my team',
    headInfluencers: people.filter(u => u.role === 'head_influencer').length,
    influencers: influencers.length,
    activeInfluencers: influencers.filter(u => u.status === 'active').length,
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
      .map(u => ({ id: u.id, name: u.full_name, pct: u.compliance.compliancePct, missed: u.compliance.missedDays }))
  });
});

/* ----------------------------------- CSV export ----------------------------------- */
r.get('/export.csv', (req, res) => {
  const rows = roster(req.user).map(u => {
    const c = u.role === 'influencer' ? complianceFor(u.id) : null;
    const pay = get(
      `SELECT COALESCE(SUM(CASE WHEN status = 'released' THEN amount ELSE 0 END), 0) AS released,
              COALESCE(SUM(CASE WHEN status <> 'released' THEN amount ELSE 0 END), 0) AS pending
         FROM payments WHERE user_id = ?`, u.id);
    return {
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
    };
  });

  const header = Object.keys(rows[0] || { id: '', name: '', role: '' });
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [header.join(','), ...rows.map(r2 => header.map(h => esc(r2[h])).join(','))].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="qht-compliance-${today()}.csv"`);
  res.send(csv);
});

export default r;
