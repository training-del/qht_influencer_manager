import { Router } from 'express';
import { get, all, run, audit, canView } from '../lib/db.js';
import { authenticate } from '../lib/auth.js';

const r = Router();
r.use(authenticate);

/** The active T&C version + its clause checklist. */
r.get('/current', (req, res) => {
  const v = get(`SELECT * FROM agreement_versions WHERE is_active = 1 ORDER BY id DESC LIMIT 1`);
  if (!v) return res.status(404).json({ error: 'No active agreement version configured' });
  res.json({
    ...v,
    clauses: JSON.parse(v.clauses_json),
    tokenAmount: req.user.token_amount,
    payoutCycle: req.user.payout_cycle
  });
});

/** The agreement this user already accepted (viewable any time). */
r.get('/mine', (req, res) => {
  const a = get(
    `SELECT a.*, v.title, v.summary, v.clauses_json, v.duration_days, v.min_compliance
       FROM agreements a JOIN agreement_versions v ON v.id = a.version_id
      WHERE a.user_id = ? ORDER BY a.id DESC LIMIT 1`, req.user.id);
  if (!a) return res.status(404).json({ error: 'No agreement accepted yet' });
  res.json({ ...a, clauses: JSON.parse(a.clauses_json), accepted_clauses: JSON.parse(a.accepted_clauses) });
});

/** Read another user's accepted agreement (admin, or head for their downline). */
r.get('/user/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!canView(req.user, id)) return res.status(403).json({ error: 'Outside your hierarchy' });
  const a = get(
    `SELECT a.*, v.title, v.clauses_json FROM agreements a
       JOIN agreement_versions v ON v.id = a.version_id
      WHERE a.user_id = ? ORDER BY a.id DESC LIMIT 1`, id);
  if (!a) return res.status(404).json({ error: 'Not accepted yet' });
  res.json({ ...a, clauses: JSON.parse(a.clauses_json), accepted_clauses: JSON.parse(a.accepted_clauses) });
});

/**
 * Accept the agreement. Every clause marked required must be ticked and the
 * typed signature must match the registered name — otherwise no access.
 */
r.post('/accept', (req, res) => {
  const { versionId, acceptedClauses, signatureName } = req.body || {};
  const v = get(`SELECT * FROM agreement_versions WHERE id = ?`, Number(versionId));
  if (!v) return res.status(400).json({ error: 'Unknown agreement version' });

  const clauses = JSON.parse(v.clauses_json);
  const ticked = Array.isArray(acceptedClauses) ? acceptedClauses : [];
  const missing = clauses.filter(c => c.required && !ticked.includes(c.key));
  if (missing.length) {
    return res.status(400).json({ error: 'All required terms must be accepted', missing: missing.map(c => c.key) });
  }
  if (!signatureName || signatureName.trim().toLowerCase() !== req.user.full_name.trim().toLowerCase()) {
    return res.status(400).json({ error: `Signature must exactly match your registered name: ${req.user.full_name}` });
  }

  const existing = get(`SELECT id FROM agreements WHERE user_id = ? AND version_id = ?`, req.user.id, v.id);
  if (!existing) {
    run(`INSERT INTO agreements
          (user_id, version_id, version_label, signature_name, accepted_clauses, token_amount_snap, ip_address, user_agent)
         VALUES (?,?,?,?,?,?,?,?)`,
      req.user.id, v.id, v.version, signatureName.trim(), JSON.stringify(ticked),
      req.user.token_amount, req.ip || '', req.headers['user-agent'] || '');
  }
  run(`UPDATE users SET status = 'active', updated_at = datetime('now') WHERE id = ?`, req.user.id);
  audit(req.user.id, 'accept_agreement', 'agreements', v.id, { version: v.version });
  res.json({ ok: true, status: 'active' });
});

/** Admin: list versions (audit / compliance evidence). */
r.get('/versions', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  res.json(all(`SELECT id, version, title, duration_days, min_compliance, is_active, created_at
                  FROM agreement_versions ORDER BY id DESC`));
});

export default r;
