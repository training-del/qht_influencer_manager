import { Router } from 'express';
import multer from 'multer';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { get, all, run, audit, visibleUserIds, canView } from '../lib/db.js';
import { UPLOADS_DIR } from '../lib/config.js';
import { authenticate, requireRole, requireAgreement, requirePasswordSet } from '../lib/auth.js';
import { complianceFor } from '../lib/compliance.js';

const storage = multer.diskStorage({
  destination: join(UPLOADS_DIR, 'proofs'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${randomUUID().slice(0, 8)}${extname(file.originalname) || '.jpg'}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    const err = new Error('Only image files are accepted');
    err.status = 400;                       // client error, not a server fault
    cb(err);
  }
});

const today = () => new Date().toLocaleDateString('en-CA');

const r = Router();
r.use(authenticate, requireAgreement, requirePasswordSet);

/* --------------------- upload daily proof (influencer or head) --------------------- */
/**
 * One submission per calendar day. Re-uploading the same day replaces the photo.
 * Head Influencers sign the same agreement — daily consumption and a daily photo —
 * so they submit their own proof too; only the admin has no proof to give.
 */
r.post('/', requireRole('influencer', 'head_influencer'), upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A proof photo is required' });

  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.date || '') ? req.body.date : today();
  if (date > today()) return res.status(400).json({ error: 'Cannot submit for a future date' });

  const relPath = 'proofs/' + req.file.filename;
  const existing = get(`SELECT id, status FROM daily_submissions WHERE user_id = ? AND submission_date = ?`,
    req.user.id, date);

  if (existing) {
    if (existing.status === 'approved') {
      return res.status(409).json({ error: 'This day is already approved and cannot be changed' });
    }
    run(
      `UPDATE daily_submissions
          SET photo_path = ?, note = ?, captured_at = datetime('now'),
              status = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL
        WHERE id = ?`,
      relPath, req.body?.note || null, existing.id);
    audit(req.user.id, 'resubmit_proof', 'daily_submissions', existing.id, { date });
    return res.json({ ok: true, replaced: true, id: existing.id, date });
  }

  const info = run(
    `INSERT INTO daily_submissions (user_id, submission_date, photo_path, note) VALUES (?,?,?,?)`,
    req.user.id, date, relPath, req.body?.note || null);
  audit(req.user.id, 'submit_proof', 'daily_submissions', info.lastInsertRowid, { date });
  res.status(201).json({ ok: true, id: info.lastInsertRowid, date });
});

/* ------------------------- influencer: own history / calendar ------------------------- */
r.get('/mine', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  const rows = all(
    `SELECT id, submission_date, photo_path, note, status, review_note, captured_at
       FROM daily_submissions
      WHERE user_id = ? AND substr(submission_date, 1, 7) = ?
      ORDER BY submission_date DESC`, req.user.id, month);

  res.json({ month, submissions: rows, compliance: complianceFor(req.user.id), today: today() });
});

/* --------------------- admin / head: review queue across the team --------------------- */
r.get('/', requireRole('admin', 'head_influencer'), (req, res) => {
  const ids = visibleUserIds(req.user);
  if (!ids.length) return res.json([]);

  const filters = [`s.user_id IN (${ids.map(() => '?').join(',')})`];
  const params = [...ids];
  if (req.query.status) { filters.push('s.status = ?'); params.push(req.query.status); }
  if (req.query.date) { filters.push('s.submission_date = ?'); params.push(req.query.date); }
  if (/^\d{4}-\d{2}$/.test(req.query.month || '')) {
    filters.push('substr(s.submission_date, 1, 7) = ?');
    params.push(req.query.month);
  }
  if (req.query.userId) { filters.push('s.user_id = ?'); params.push(Number(req.query.userId)); }

  res.json(all(
    `SELECT s.*, u.full_name, u.phone, u.role,
            p.full_name AS parent_name
       FROM daily_submissions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN users p ON p.id = u.parent_id
      WHERE ${filters.join(' AND ')}
      ORDER BY s.submission_date DESC, s.id DESC
      LIMIT ?`, ...params, Number(req.query.limit) || 200));
});

/* ------------------------------- review one submission ------------------------------- */
/**
 * Approve, reject or flag a proof. A Head Influencer reviews their own downline;
 * the admin reviews everyone. Nobody reviews their own photo — a head influencer
 * submits proof too, and signing off on your own evidence is not a review.
 */
r.patch('/:id/review', requireRole('admin', 'head_influencer'), (req, res) => {
  const status = req.body?.status;
  if (!['approved', 'rejected', 'flagged', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'status must be approved, rejected, flagged or pending' });
  }

  const sub = get(`SELECT * FROM daily_submissions WHERE id = ?`, Number(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Not found' });
  if (sub.user_id === req.user.id) {
    return res.status(403).json({ error: 'You cannot review your own submission' });
  }
  if (!canView(req.user, sub.user_id)) return res.status(403).json({ error: 'Outside your hierarchy' });

  run(
    `UPDATE daily_submissions
        SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_note = ?
      WHERE id = ?`,
    status, req.user.id, req.body?.reviewNote || null, sub.id);
  audit(req.user.id, 'review_submission', 'daily_submissions', sub.id, { status });
  res.json({ ok: true });
});

/* ------------------------- team calendar for one influencer ------------------------- */
r.get('/user/:id', requireRole('admin', 'head_influencer'), (req, res) => {
  const id = Number(req.params.id);
  if (!canView(req.user, id)) return res.status(403).json({ error: 'Outside your hierarchy' });

  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  res.json({
    month,
    submissions: all(
      `SELECT id, submission_date, photo_path, note, status, review_note
         FROM daily_submissions
        WHERE user_id = ? AND substr(submission_date, 1, 7) = ?
        ORDER BY submission_date DESC`, id, month),
    compliance: complianceFor(id)
  });
});

export default r;
