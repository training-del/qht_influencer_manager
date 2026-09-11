/**
 * How much of the programme someone has actually kept up with.
 *
 * Ported from server/lib/compliance.js. Same arithmetic; the queries are async
 * and take the database explicitly, because a Worker has no module-level
 * connection to reach for.
 */

/** Days since this user accepted their agreement, counting today. At least 1. */
export async function activeDays(db, userId) {
  const row = await db.prepare(
    `SELECT CAST(julianday('now','localtime') - julianday(date(accepted_at)) AS INTEGER) + 1 AS d
       FROM agreements WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`
  ).bind(userId).first();
  return Math.max(1, row?.d ?? 1);
}

/**
 * Approved plus still-pending submissions over the days since acceptance.
 * A photo waiting to be reviewed counts as sent — the influencer did their
 * part. A rejected one does not, and lands as a missed day.
 */
export async function complianceFor(db, userId) {
  const days = await activeDays(db, userId);
  const s = await db.prepare(
    `SELECT
        COUNT(*)                 AS total,
        SUM(status = 'approved') AS approved,
        SUM(status = 'pending')  AS pending,
        SUM(status = 'rejected') AS rejected,
        SUM(status = 'flagged')  AS flagged,
        MAX(submission_date)     AS last_date
       FROM daily_submissions WHERE user_id = ?1`
  ).bind(userId).first() || {};

  const approved = s.approved || 0;
  const pending = s.pending || 0;
  const counted = approved + pending;
  const missed = Math.max(0, days - counted);
  const today = new Date().toLocaleDateString('en-CA');    // YYYY-MM-DD, local day

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
