import { Router } from 'express';
import multer from 'multer';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { db, get, all, run, audit, descendantIds, visibleUserIds, canView } from '../lib/db.js';
import { UPLOADS_DIR } from '../lib/config.js';
import { authenticate, requireRole, requireAgreement, requirePasswordSet, hashPassword } from '../lib/auth.js';
import { complianceFor } from '../lib/compliance.js';
import { validatePhone, validateCountryCode, DEFAULT_COUNTRY } from '../lib/phone.js';

const upload = multer({
  dest: join(UPLOADS_DIR, 'idproofs'),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const r = Router();
r.use(authenticate, requireAgreement, requirePasswordSet);

const COLS = [
  'id', 'role', 'parent_id', 'full_name', 'phone', 'country_code', 'email', 'address',
  'id_proof_type', 'id_proof_number', 'id_proof_file',
  'bank_account_name', 'bank_account_no', 'bank_ifsc', 'upi_id',
  'status', 'token_amount', 'payout_cycle', 'next_payout_date', 'created_at'
];
const PUBLIC_COLS = COLS.join(', ');

/* --------------------------- register a new person --------------------------- */
/** Admin registers head_influencer | influencer. Head Influencer registers influencer only. */
r.post('/', requireRole('admin', 'head_influencer'), upload.single('idProofFile'), (req, res) => {
  const b = req.body || {};
  const role = b.role === 'head_influencer' ? 'head_influencer' : 'influencer';

  if (req.user.role === 'head_influencer' && role !== 'influencer') {
    return res.status(403).json({ error: 'A Head Influencer can only register Influencers' });
  }
  /* Registration asks only for what the admin can know: who they are and the
     two ways to reach them. The rest is theirs to fill in — see PATCH /me. */
  for (const [field, label] of [
    ['fullName', 'Full name'], ['phone', 'Phone number'],
    ['email', 'Email'], ['password', 'Temporary password']
  ]) {
    if (!b[field]?.trim()) return res.status(400).json({ error: `${label} is required` });
  }
  if (!/^[^@s]+@[^@s.]+.[^@s]+$/.test(b.email.trim())) {
    return res.status(400).json({ error: 'That email address does not look right' });
  }
  if (String(b.password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  // Exactly 10 digits; on +91 the number must also start 6-9.
  const countryCode = validateCountryCode(b.countryCode) || DEFAULT_COUNTRY;
  const checked = validatePhone(b.phone, countryCode);
  if (!checked.ok) return res.status(400).json({ error: checked.error, field: 'phone' });
  const phone = checked.phone;

  // Admin may place an influencer directly under a chosen Head Influencer.
  let parentId = req.user.id;
  if (req.user.role === 'admin' && role === 'influencer' && b.parentId && Number(b.parentId) !== req.user.id) {
    const head = get(`SELECT id, role FROM users WHERE id = ?`, Number(b.parentId));
    if (!head || head.role !== 'head_influencer') {
      return res.status(400).json({ error: 'parentId must be a Head Influencer' });
    }
    parentId = head.id;
  }

  if (get(`SELECT id FROM users WHERE phone = ?`, phone)) {
    return res.status(409).json({ error: 'That phone number is already registered' });
  }
  if (b.email && get(`SELECT id FROM users WHERE lower(email) = lower(?)`, b.email)) {
    return res.status(409).json({ error: 'That email is already registered' });
  }

  const info = run(
    `INSERT INTO users (role, parent_id, full_name, phone, country_code, email, address, id_proof_type, id_proof_number,
       id_proof_file, bank_account_name, bank_account_no, bank_ifsc, upi_id, password_hash, must_change_pw,
       status, token_amount, payout_cycle, next_payout_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'pending_agreement',?,?,?)`,
    role, parentId, b.fullName.trim(), phone, countryCode, b.email?.trim() || null, b.address || null,
    b.idProofType || null, b.idProofNumber || null,
    req.file ? 'idproofs/' + req.file.filename : null,
    b.bankAccountName || null, b.bankAccountNo || null, b.bankIfsc || null, b.upiId || null,
    hashPassword(b.password), Number(b.tokenAmount) || 0,
    b.payoutCycle || 'monthly', b.nextPayoutDate || null
  );

  audit(req.user.id, 'register_user', 'users', info.lastInsertRowid, { role, parentId });
  res.status(201).json({
    user: get(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?`, info.lastInsertRowid),
    note: 'Registered. They must sign in and accept the agreement before any dashboard access.'
  });
});

/* ------------------------------ scoped listing ------------------------------ */
/** Admin sees everyone; a Head Influencer sees only their own downline. */
r.get('/', requireRole('admin', 'head_influencer'), (req, res) => {
  const ids = visibleUserIds(req.user);
  if (!ids.length) return res.json([]);

  const filters = [`u.id IN (${ids.map(() => '?').join(',')})`];
  const params = [...ids];
  if (req.query.role) { filters.push('u.role = ?'); params.push(req.query.role); }
  if (req.query.status) { filters.push('u.status = ?'); params.push(req.query.status); }

  const rows = all(
    `SELECT ${COLS.map(c => 'u.' + c).join(', ')},
            p.full_name AS parent_name, p.role AS parent_role,
            (SELECT COUNT(*) FROM users c WHERE c.parent_id = u.id) AS team_size
       FROM users u LEFT JOIN users p ON p.id = u.parent_id
      WHERE ${filters.join(' AND ')}
      ORDER BY u.role, u.full_name`, ...params);

  // heads owe the same daily photo, so they get a compliance figure as well
  res.json(rows.map(u => (u.role === 'admin' ? u : { ...u, compliance: complianceFor(u.id) })));
});

/** Head Influencers only — used to populate the "place under" dropdown for admin. */
r.get('/heads', requireRole('admin'), (req, res) => {
  res.json(all(
    `SELECT id, full_name, phone, token_amount, status,
            (SELECT COUNT(*) FROM users c WHERE c.parent_id = u.id) AS team_size
       FROM users u WHERE role = 'head_influencer' ORDER BY full_name`));
});

/* -------------------------------- hierarchy -------------------------------- */
/** Org-chart tree: rooted at the admin, or at the head influencer for their own team. */
r.get('/tree', requireRole('admin', 'head_influencer'), (req, res) => {
  const rootId = req.user.role === 'admin'
    ? (get(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`)?.id ?? req.user.id)
    : req.user.id;

  const ids = [rootId, ...descendantIds(rootId)];
  const rows = all(
    `SELECT id, role, parent_id, full_name, status, token_amount
       FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);

  const byId = new Map(rows.map(u => [u.id, {
    ...u,
    compliance: u.role === 'influencer' ? complianceFor(u.id) : null,
    children: []
  }]));

  let root = null;
  for (const node of byId.values()) {
    if (node.id === rootId) { root = node; continue; }
    byId.get(node.parent_id)?.children.push(node);
  }
  res.json(root);
});

/* ------------------------------ single profile ------------------------------ */
r.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!canView(req.user, id)) return res.status(403).json({ error: 'Outside your hierarchy' });

  const u = get(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?`, id);
  if (!u) return res.status(404).json({ error: 'Not found' });

  const parent = u.parent_id ? get(`SELECT id, full_name, role FROM users WHERE id = ?`, u.parent_id) : null;
  res.json({ ...u, registeredBy: parent, compliance: u.role === 'influencer' ? complianceFor(id) : null });
});

/* --------------------------- filling in your own details --------------------------- */
/**
 * Mirrors the Worker's PATCH /users/me — see worker/src/routes/users.js, which
 * is the copy that actually runs in production. Both must allow exactly the
 * same fields: role, parent, token amount, status and phone are deliberately
 * not among them.
 */
const OWN_FIELDS = {
  email: 'email',
  address: 'address',
  idProofType: 'id_proof_type',
  idProofNumber: 'id_proof_number',
  bankAccountName: 'bank_account_name',
  bankAccountNo: 'bank_account_no',
  bankIfsc: 'bank_ifsc',
  upiId: 'upi_id'
};

r.patch('/me', upload.single('idProofFile'), (req, res) => {
  const given = req.body || {};
  const sets = [];
  const values = [];

  for (const [field, column] of Object.entries(OWN_FIELDS)) {
    if (!(field in given)) continue;
    const value = String(given[field] ?? '').trim();

    if (field === 'email') {
      if (!value) return res.status(400).json({ error: 'Email cannot be emptied' });
      if (!/^[^@s]+@[^@s.]+.[^@s]+$/.test(value)) {
        return res.status(400).json({ error: 'That email address does not look right' });
      }
      if (get(`SELECT id FROM users WHERE lower(email) = lower(?) AND id <> ?`, value, req.user.id)) {
        return res.status(409).json({ error: 'That email is already registered' });
      }
    }

    values.push(value || null);
    sets.push(`${column} = ?`);
  }

  if (req.file) {
    values.push('idproofs/' + req.file.filename);
    sets.push('id_proof_file = ?');
  }

  if (!sets.length) return res.status(400).json({ error: 'Nothing to save' });

  values.push(req.user.id);
  run(`UPDATE users SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...values);
  audit(req.user.id, 'update_own_profile', 'users', req.user.id, { fields: sets.length });

  res.json({ ok: true, user: get(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?`, req.user.id) });
});

/* ------------------------- token amount / status edits ------------------------- */
r.patch('/:id/token', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const amount = Number(req.body?.tokenAmount);
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ error: 'tokenAmount must be a positive number' });
  }

  const target = get(`SELECT id, role FROM users WHERE id = ?`, id);
  if (!target) return res.status(404).json({ error: 'Not found' });

  const ids = [id];
  // "per head-influencer group": optionally cascade the amount to the head's whole downline
  if (req.body?.applyToTeam && target.role === 'head_influencer') ids.push(...descendantIds(id));

  for (const uid of ids) {
    run(
      `UPDATE users SET token_amount = ?,
              payout_cycle = COALESCE(?, payout_cycle),
              next_payout_date = COALESCE(?, next_payout_date),
              updated_at = datetime('now')
         WHERE id = ?`,
      amount, req.body?.payoutCycle || null, req.body?.nextPayoutDate || null, uid);
  }
  audit(req.user.id, 'set_token_amount', 'users', id, { amount, appliedTo: ids.length });
  res.json({ ok: true, updated: ids.length });
});

/* --------------------------- move an influencer ---------------------------- */
/**
 * Admin reassigns an influencer to a different Head Influencer, or back to
 * reporting directly to the admin. Only influencers move — a Head Influencer
 * always sits directly under the admin.
 */
r.patch('/:id/parent', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const target = get(`SELECT id, role, full_name, parent_id FROM users WHERE id = ?`, id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (target.role !== 'influencer') {
    return res.status(400).json({ error: 'Only influencers can be reassigned' });
  }

  const adminId = get(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`)?.id ?? req.user.id;
  const raw = req.body?.parentId;

  // empty / null / the admin's own id all mean "reports directly to QHT Admin"
  let newParentId = adminId;
  let newParentName = 'QHT Admin';

  if (raw !== null && raw !== undefined && raw !== '' && Number(raw) !== adminId) {
    const head = get(`SELECT id, role, full_name FROM users WHERE id = ?`, Number(raw));
    if (!head || head.role !== 'head_influencer') {
      return res.status(400).json({ error: 'Choose a Head Influencer, or QHT Admin' });
    }
    if (head.id === id) return res.status(400).json({ error: 'Someone cannot report to themselves' });
    newParentId = head.id;
    newParentName = head.full_name;
  }

  if (newParentId === target.parent_id) {
    return res.json({ ok: true, unchanged: true, parentName: newParentName });
  }

  const from = target.parent_id
    ? get(`SELECT full_name FROM users WHERE id = ?`, target.parent_id)?.full_name
    : 'QHT Admin';

  run(`UPDATE users SET parent_id = ?, updated_at = datetime('now') WHERE id = ?`, newParentId, id);
  audit(req.user.id, 'reassign_user', 'users', id,
        { name: target.full_name, from, to: newParentName });

  res.json({ ok: true, parentName: newParentName, from });
});

/* ------------------------------ delete a person ------------------------------ */
/** What disappears if this account is removed — shown in the confirm dialog. */
r.get('/:id/impact', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const u = get(`SELECT id, role, full_name, parent_id FROM users WHERE id = ?`, id);
  if (!u) return res.status(404).json({ error: 'Not found' });

  const children = all(
    `SELECT id, full_name, role FROM users WHERE parent_id = ? ORDER BY full_name`, id);

  res.json({
    id: u.id,
    fullName: u.full_name,
    role: u.role,
    submissions: get(`SELECT COUNT(*) n FROM daily_submissions WHERE user_id = ?`, id).n,
    payments: get(`SELECT COUNT(*) n FROM payments WHERE user_id = ?`, id).n,
    releasedAmount: get(
      `SELECT COALESCE(SUM(amount), 0) a FROM payments WHERE user_id = ? AND status = 'released'`, id).a,
    hasAgreement: !!get(`SELECT id FROM agreements WHERE user_id = ? LIMIT 1`, id),
    children,
    reassignTo: u.parent_id
      ? get(`SELECT id, full_name FROM users WHERE id = ?`, u.parent_id)
      : null
  });
});

/**
 * Permanently removes a person. Agreements, submissions and payments cascade;
 * the rows that merely *point* at them (who reviewed a photo, who released a
 * payment, audit entries) are detached first so the delete cannot fail on a
 * foreign key. A person with a team is refused unless reassignChildren is set.
 */
r.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const u = get(`SELECT id, role, full_name, parent_id FROM users WHERE id = ?`, id);
  if (!u) return res.status(404).json({ error: 'Not found' });

  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  if (u.role === 'admin') return res.status(400).json({ error: 'Admin accounts cannot be deleted' });

  const children = all(`SELECT id FROM users WHERE parent_id = ?`, id).map(c => c.id);
  const reassign = req.body?.reassignChildren === true || req.query.reassignChildren === 'true';

  if (children.length && !reassign) {
    return res.status(409).json({
      error: `${u.full_name} still has ${children.length} influencer(s) under them.`,
      code: 'HAS_TEAM',
      teamSize: children.length
    });
  }

  // photo files are outside the database, so collect the paths before the cascade
  const files = all(`SELECT photo_path FROM daily_submissions WHERE user_id = ?`, id)
    .map(s => s.photo_path)
    .concat(get(`SELECT id_proof_file f FROM users WHERE id = ?`, id).f || []);

  db.exec('BEGIN');
  try {
    if (children.length) {
      // move the team up to whoever registered the person being removed
      run(`UPDATE users SET parent_id = ?, updated_at = datetime('now') WHERE parent_id = ?`,
          u.parent_id ?? req.user.id, id);
    }
    run(`UPDATE daily_submissions SET reviewed_by = NULL WHERE reviewed_by = ?`, id);
    run(`UPDATE payments SET released_by = NULL WHERE released_by = ?`, id);
    run(`UPDATE audit_log SET actor_id = NULL WHERE actor_id = ?`, id);
    run(`DELETE FROM users WHERE id = ?`, id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'Could not delete: ' + err.message });
  }

  for (const rel of files) {
    if (rel) { try { unlinkSync(join(UPLOADS_DIR, rel)); } catch { /* already gone */ } }
  }

  audit(req.user.id, 'delete_user', 'users', id,
        { name: u.full_name, role: u.role, reassigned: children.length });
  res.json({ ok: true, deleted: u.full_name, reassigned: children.length });
});

r.patch('/:id/status', requireRole('admin'), (req, res) => {
  const status = req.body?.status;
  if (!['active', 'suspended', 'pending_agreement'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'You cannot change your own status' });
  }
  run(`UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?`, status, Number(req.params.id));
  audit(req.user.id, 'set_status', 'users', Number(req.params.id), { status });
  res.json({ ok: true });
});

export default r;
