import { Router } from 'express';
import { get, all, run, audit, visibleUserIds, canView } from '../lib/db.js';
import { authenticate, requireRole, requireAgreement, requirePasswordSet } from '../lib/auth.js';
import { complianceFor } from '../lib/compliance.js';

const r = Router();
r.use(authenticate, requireAgreement, requirePasswordSet);

/* ---------------------------- influencer: my payouts ---------------------------- */
r.get('/mine', (req, res) => {
  res.json({
    tokenAmount: req.user.token_amount,
    payoutCycle: req.user.payout_cycle,
    nextPayoutDate: req.user.next_payout_date,
    compliance: complianceFor(req.user.id),
    payments: all(
      `SELECT id, period_start, period_end, amount, compliance_pct, status, released_at, reference_no, note
         FROM payments WHERE user_id = ? ORDER BY period_start DESC`, req.user.id)
  });
});

/* --------------------------- admin / head: team payouts --------------------------- */
r.get('/', requireRole('admin', 'head_influencer'), (req, res) => {
  const ids = visibleUserIds(req.user);
  if (!ids.length) return res.json([]);

  const filters = [`p.user_id IN (${ids.map(() => '?').join(',')})`];
  const params = [...ids];
  if (req.query.status) { filters.push('p.status = ?'); params.push(req.query.status); }

  res.json(all(
    `SELECT p.*, u.full_name, u.phone, u.role, u.upi_id, u.bank_account_no
       FROM payments p JOIN users u ON u.id = p.user_id
      WHERE ${filters.join(' AND ')}
      ORDER BY p.status = 'released', p.period_end DESC`, ...params));
});

/* ------------------------------ admin: raise a payout ------------------------------ */
r.post('/', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const userId = Number(b.userId);
  if (!canView(req.user, userId)) return res.status(400).json({ error: 'Unknown user' });

  const u = get(`SELECT id, token_amount FROM users WHERE id = ?`, userId);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (!b.periodStart || !b.periodEnd) return res.status(400).json({ error: 'periodStart and periodEnd are required' });

  const c = complianceFor(userId);
  const amount = Number.isFinite(Number(b.amount)) && b.amount !== '' ? Number(b.amount) : u.token_amount;

  const info = run(
    `INSERT INTO payments (user_id, period_start, period_end, amount, compliance_pct, status, note)
     VALUES (?,?,?,?,?,?,?)`,
    userId, b.periodStart, b.periodEnd, amount, c.compliancePct,
    ['pending', 'on_hold', 'released'].includes(b.status) ? b.status : 'pending',
    b.note || null);

  audit(req.user.id, 'create_payment', 'payments', info.lastInsertRowid, { userId, amount });
  res.status(201).json({ ok: true, id: info.lastInsertRowid, amount, compliancePct: c.compliancePct });
});

/* ---------------------------- admin: mark payout released ---------------------------- */
r.patch('/:id', requireRole('admin'), (req, res) => {
  const p = get(`SELECT * FROM payments WHERE id = ?`, Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found' });

  const status = req.body?.status;
  if (!['pending', 'on_hold', 'released'].includes(status)) {
    return res.status(400).json({ error: 'status must be pending, on_hold or released' });
  }

  run(
    `UPDATE payments
        SET status = ?,
            released_at = CASE WHEN ? = 'released' THEN datetime('now') ELSE NULL END,
            released_by = CASE WHEN ? = 'released' THEN ? ELSE NULL END,
            reference_no = COALESCE(?, reference_no),
            note = COALESCE(?, note)
      WHERE id = ?`,
    status, status, status, req.user.id, req.body?.referenceNo || null, req.body?.note || null, p.id);

  audit(req.user.id, 'update_payment', 'payments', p.id, { status });
  res.json({ ok: true });
});

export default r;
