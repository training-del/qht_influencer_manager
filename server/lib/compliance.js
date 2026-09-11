import { get } from './db.js';

/** Days elapsed since a user's agreement was accepted (inclusive, min 1). */
export function activeDays(userId) {
  const row = get(
    `SELECT CAST(julianday('now','localtime') - julianday(date(accepted_at)) AS INTEGER) + 1 AS d
       FROM agreements WHERE user_id = ? ORDER BY id DESC LIMIT 1`, userId);
  return Math.max(1, row?.d ?? 1);
}

/**
 * Compliance for one influencer: approved + pending submissions over the days
 * elapsed since agreement acceptance. Rejected days count as missed.
 */
export function complianceFor(userId) {
  const days = activeDays(userId);
  const s = get(
    `SELECT
        COUNT(*)                 AS total,
        SUM(status = 'approved') AS approved,
        SUM(status = 'pending')  AS pending,
        SUM(status = 'rejected') AS rejected,
        SUM(status = 'flagged')  AS flagged,
        MAX(submission_date)     AS last_date
       FROM daily_submissions WHERE user_id = ?`, userId) || {};

  const approved = s.approved || 0;
  const pending = s.pending || 0;
  const counted = approved + pending;            // not-yet-reviewed still counts as submitted
  const missed = Math.max(0, days - counted);
  const today = new Date().toLocaleDateString('en-CA');   // YYYY-MM-DD, local day

  return {
    daysActive: days,
    submitted: s.total || 0,
    approved,
    pending,
    rejected: s.rejected || 0,
    flagged: s.flagged || 0,
    missedDays: missed,
    lastSubmission: s.last_date || null,
    submittedToday: s.last_date === today,
    compliancePct: Math.round((counted / days) * 1000) / 10
  };
}
