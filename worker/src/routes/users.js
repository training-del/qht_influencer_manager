/**
 * Registering people, listing them, the org tree, and the admin-only edits.
 *
 * Ported from server/routes/users.js. Behaviour is unchanged. Two things had to
 * be done differently on Workers:
 *
 *   - the ID-proof upload arrives as multipart form data and goes to R2 rather
 *     than to multer and the local disk
 *   - D1 has no synchronous transaction, so the delete uses batch(), which is
 *     applied atomically by D1
 */
import { hashPassword, roundsFor } from '../auth.js';
import {
  HttpError, assertRole, assertCanView, assertAgreementAccepted, assertPasswordSet,
  descendantIds, visibleUserIds, canView
} from '../access.js';
import { complianceFor } from '../lib/compliance.js';
import { validatePhone, validateCountryCode, DEFAULT_COUNTRY } from '../lib/phone.js';
import { discard, restoreReferenced } from '../lib/trash.js';

const COLS = [
  'id', 'role', 'parent_id', 'full_name', 'phone', 'country_code', 'email', 'address',
  'id_proof_type', 'id_proof_number', 'id_proof_file',
  'bank_account_name', 'bank_account_no', 'bank_ifsc', 'upi_id',
  'status', 'token_amount', 'payout_cycle', 'next_payout_date', 'created_at'
];
const PUBLIC_COLS = COLS.join(', ');

const audit = (env, actorId, action, entity, entityId, meta) =>
  env.DB.prepare(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, meta) VALUES (?1,?2,?3,?4,?5)`
  ).bind(actorId ?? null, action, entity ?? null, entityId ?? null,
         meta ? JSON.stringify(meta) : null).run();

/** Everything past sign-in needs both onboarding steps finished. */
const gate = user => { assertAgreementAccepted(user); assertPasswordSet(user); };

const jsonBody = async request => {
  try { return await request.json(); } catch { return {}; }
};

/** Placeholders for a variable-length IN list: ?1, ?2, ?3 … */
const placeholders = (n, from = 1) =>
  Array.from({ length: n }, (_, i) => `?${i + from}`).join(',');

/* --------------------------- register a new person --------------------------- */
/** Admin registers a head influencer or an influencer; a head registers influencers. */
async function register({ request, env, user, json }) {
  gate(user);
  assertRole(user, 'admin', 'head_influencer');

  /* The form carries a file, so it arrives as multipart rather than JSON.
     FormData gives both the fields and the file in one pass. */
  const form = await request.formData();
  const b = Object.fromEntries(
    [...form.entries()].filter(([, v]) => typeof v === 'string')
  );
  const file = form.get('idProofFile');

  const role = b.role === 'head_influencer' ? 'head_influencer' : 'influencer';
  if (user.role === 'head_influencer' && role !== 'influencer') {
    throw new HttpError(403, 'A Head Influencer can only register Influencers');
  }
  /* Registration asks for the three things only the admin can know: who they
     are, and the two ways to reach them. Address, ID proof and bank details are
     left to the person themselves — see updateSelf below. */
  for (const [field, label] of [
    ['fullName', 'Full name'], ['phone', 'Phone number'],
    ['email', 'Email'], ['password', 'Temporary password']
  ]) {
    if (!b[field]?.trim()) throw new HttpError(400, `${label} is required`);
  }
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(b.email.trim())) {
    throw new HttpError(400, 'That email address does not look right');
  }
  if (String(b.password).length < 6) {
    throw new HttpError(400, 'Password must be at least 6 characters');
  }

  // exactly 10 digits; on +91 the number must also start 6-9
  const countryCode = validateCountryCode(b.countryCode) || DEFAULT_COUNTRY;
  const checked = validatePhone(b.phone, countryCode);
  if (!checked.ok) throw new HttpError(400, checked.error);
  const phone = checked.phone;

  // an admin may place an influencer straight under a chosen head influencer
  let parentId = user.id;
  if (user.role === 'admin' && role === 'influencer' && b.parentId && Number(b.parentId) !== user.id) {
    const head = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?1')
      .bind(Number(b.parentId)).first();
    if (!head || head.role !== 'head_influencer') {
      throw new HttpError(400, 'parentId must be a Head Influencer');
    }
    parentId = head.id;
  }

  if (await env.DB.prepare('SELECT id FROM users WHERE phone = ?1').bind(phone).first()) {
    throw new HttpError(409, 'That phone number is already registered');
  }
  if (b.email && await env.DB.prepare('SELECT id FROM users WHERE lower(email) = lower(?1)')
      .bind(b.email).first()) {
    throw new HttpError(409, 'That email is already registered');
  }

  /* The ID document goes to R2 under a name nobody can guess, so a leaked
     object key is not a way to enumerate other people's documents. */
  let idProofKey = null;
  if (file && typeof file !== 'string' && file.size) {
    if (!/^image\//.test(file.type)) throw new HttpError(400, 'ID proof must be an image');
    if (file.size > 8 * 1024 * 1024) throw new HttpError(413, 'ID proof must be under 8 MB');
    const ext = (file.name?.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0].toLowerCase();
    idProofKey = `idproofs/${crypto.randomUUID()}${ext}`;
    await env.PHOTOS.put(idProofKey, file.stream(), {
      httpMetadata: { contentType: file.type }
    });
  }

  const info = await env.DB.prepare(
    `INSERT INTO users (role, parent_id, full_name, phone, country_code, email, address,
       id_proof_type, id_proof_number, id_proof_file, bank_account_name, bank_account_no,
       bank_ifsc, upi_id, password_hash, must_change_pw, status, token_amount,
       payout_cycle, next_payout_date)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,1,'pending_agreement',?16,?17,?18)`
  ).bind(
    role, parentId, b.fullName.trim(), phone, countryCode, b.email?.trim() || null,
    b.address || null, b.idProofType || null, b.idProofNumber || null, idProofKey,
    b.bankAccountName || null, b.bankAccountNo || null, b.bankIfsc || null, b.upiId || null,
    await hashPassword(b.password, roundsFor(env)), Number(b.tokenAmount) || 0,
    b.payoutCycle || 'monthly', b.nextPayoutDate || null
  ).run();

  const id = info.meta.last_row_id;
  await audit(env, user.id, 'register_user', 'users', id, { role, parentId });

  return json({
    user: await env.DB.prepare(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?1`).bind(id).first(),
    note: 'Registered. They must sign in and accept the agreement before any dashboard access.'
  }, 201);
}

/* ------------------------------ scoped listing ------------------------------ */
/** Admin sees everyone; a head influencer sees only their own downline. */
async function list({ env, url, user, json }) {
  gate(user);
  assertRole(user, 'admin', 'head_influencer');

  const ids = await visibleUserIds(env.DB, user);
  if (!ids.length) return json([]);

  const params = [...ids];
  const filters = [`u.id IN (${placeholders(ids.length)})`];
  const role = url.searchParams.get('role');
  const status = url.searchParams.get('status');
  if (role) { params.push(role); filters.push(`u.role = ?${params.length}`); }
  if (status) { params.push(status); filters.push(`u.status = ?${params.length}`); }

  const { results } = await env.DB.prepare(
    `SELECT ${COLS.map(c => 'u.' + c).join(', ')},
            p.full_name AS parent_name, p.role AS parent_role,
            (SELECT COUNT(*) FROM users c WHERE c.parent_id = u.id) AS team_size
       FROM users u LEFT JOIN users p ON p.id = u.parent_id
      WHERE ${filters.join(' AND ')}
      ORDER BY u.role, u.full_name`
  ).bind(...params).all();

  // heads owe the same daily photo, so they carry a compliance figure too
  return json(await Promise.all(results.map(async u =>
    u.role === 'admin' ? u : { ...u, compliance: await complianceFor(env.DB, u.id) }
  )));
}

/** Head influencers only — fills the admin's "place under" dropdown. */
async function heads({ env, user, json }) {
  gate(user);
  assertRole(user, 'admin');
  const { results } = await env.DB.prepare(
    `SELECT id, full_name, phone, token_amount, status,
            (SELECT COUNT(*) FROM users c WHERE c.parent_id = u.id) AS team_size
       FROM users u WHERE role = 'head_influencer' ORDER BY full_name`
  ).all();
  return json(results);
}

/* -------------------------------- hierarchy -------------------------------- */
/** The org chart: rooted at the admin, or at the head influencer for their team. */
async function tree({ env, user, json }) {
  gate(user);
  assertRole(user, 'admin', 'head_influencer');

  const rootId = user.role === 'admin'
    ? ((await env.DB.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`)
        .first())?.id ?? user.id)
    : user.id;

  const ids = [rootId, ...await descendantIds(env.DB, rootId)];
  const { results } = await env.DB.prepare(
    `SELECT id, role, parent_id, full_name, status, token_amount
       FROM users WHERE id IN (${placeholders(ids.length)})`
  ).bind(...ids).all();

  const byId = new Map();
  for (const u of results) {
    byId.set(u.id, {
      ...u,
      compliance: u.role === 'influencer' ? await complianceFor(env.DB, u.id) : null,
      children: []
    });
  }

  let root = null;
  for (const node of byId.values()) {
    if (node.id === rootId) { root = node; continue; }
    byId.get(node.parent_id)?.children.push(node);
  }
  return json(root);
}

/* ------------------------------ single profile ------------------------------ */
async function one({ env, params, user, json }) {
  gate(user);
  const id = Number(params.id);
  if (!(await canView(env.DB, user, id))) throw new HttpError(403, 'Outside your hierarchy');

  const u = await env.DB.prepare(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?1`).bind(id).first();
  if (!u) throw new HttpError(404, 'Not found');

  const parent = u.parent_id
    ? await env.DB.prepare('SELECT id, full_name, role FROM users WHERE id = ?1')
        .bind(u.parent_id).first()
    : null;

  return json({
    ...u,
    registeredBy: parent,
    compliance: u.role === 'influencer' ? await complianceFor(env.DB, id) : null
  });
}

/* --------------------------- filling in your own details --------------------------- */
/**
 * Someone completing their own profile after being registered.
 *
 * The admin only enters a name, a phone number and an email — everything else
 * is the person's own to fill in, and this is where they do it.
 *
 * The list of fields here is the security boundary. Role, who they report to,
 * their token amount and their status are all deliberately absent: those decide
 * money and hierarchy, and are the admin's alone. Phone is absent too — it is
 * the login identifier, and letting someone change it would let them take over
 * an unused number or lock themselves out.
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

async function updateSelf({ request, env, user, json }) {
  gate(user);

  /* multipart, because the ID document comes with it */
  const form = await request.formData();
  const given = Object.fromEntries(
    [...form.entries()].filter(([, v]) => typeof v === 'string')
  );

  const sets = [];
  const values = [];
  for (const [field, column] of Object.entries(OWN_FIELDS)) {
    if (!(field in given)) continue;
    const value = given[field].trim();

    if (field === 'email') {
      if (!value) throw new HttpError(400, 'Email cannot be emptied');
      if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value)) {
        throw new HttpError(400, 'That email address does not look right');
      }
      const taken = await env.DB.prepare(
        'SELECT id FROM users WHERE lower(email) = lower(?1) AND id <> ?2'
      ).bind(value, user.id).first();
      if (taken) throw new HttpError(409, 'That email is already registered');
    }

    values.push(value || null);
    sets.push(`${column} = ?${values.length}`);
  }

  // the ID document, if one came with this save
  let replacedIdProof = null;
  const file = form.get('idProofFile');
  if (file && typeof file !== 'string' && file.size) {
    if (!/^image\//.test(file.type)) throw new HttpError(400, 'ID proof must be an image');
    if (file.size > 8 * 1024 * 1024) throw new HttpError(413, 'ID proof must be under 8 MB');
    const ext = (file.name?.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0].toLowerCase();
    const key = `idproofs/${crypto.randomUUID()}${ext}`;
    await env.PHOTOS.put(key, file.stream(), { httpMetadata: { contentType: file.type } });

    values.push(key);
    sets.push(`id_proof_file = ?${values.length}`);

    // the old one only goes once the row points at the new one — see below
    replacedIdProof = user.id_proof_file;
  }

  if (!sets.length) throw new HttpError(400, 'Nothing to save');

  values.push(user.id);
  await env.DB.prepare(
    `UPDATE users SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?${values.length}`
  ).bind(...values).run();

  // now the row points at the new file, the old one can go — to trash
  await discard(env, replacedIdProof, `replaced id proof of user ${user.id}`);

  await audit(env, user.id, 'update_own_profile', 'users', user.id,
    { fields: sets.map(s => s.split(' ')[0]) });

  return json({
    ok: true,
    user: await env.DB.prepare(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?1`).bind(user.id).first()
  });
}

/* ------------------------- token amount / status edits ------------------------- */
async function setToken({ request, env, params, user, json }) {
  gate(user);
  assertRole(user, 'admin');

  const id = Number(params.id);
  const b = await jsonBody(request);
  const amount = Number(b.tokenAmount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new HttpError(400, 'tokenAmount must be a positive number');
  }

  const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?1').bind(id).first();
  if (!target) throw new HttpError(404, 'Not found');

  const ids = [id];
  // optionally cascade a head influencer's amount to their whole downline
  if (b.applyToTeam && target.role === 'head_influencer') {
    ids.push(...await descendantIds(env.DB, id));
  }

  await env.DB.batch(ids.map(uid => env.DB.prepare(
    `UPDATE users SET token_amount = ?1,
            payout_cycle = COALESCE(?2, payout_cycle),
            next_payout_date = COALESCE(?3, next_payout_date),
            updated_at = datetime('now')
       WHERE id = ?4`
  ).bind(amount, b.payoutCycle || null, b.nextPayoutDate || null, uid)));

  await audit(env, user.id, 'set_token_amount', 'users', id, { amount, appliedTo: ids.length });
  return json({ ok: true, updated: ids.length });
}

/* --------------------------- move an influencer ---------------------------- */
/**
 * Admin reassigns an influencer to a different head influencer, or back to
 * reporting straight to the admin. Only influencers move — a head influencer
 * always sits directly under the admin.
 */
async function setParent({ request, env, params, user, json }) {
  gate(user);
  assertRole(user, 'admin');

  const id = Number(params.id);
  const target = await env.DB.prepare(
    'SELECT id, role, full_name, parent_id FROM users WHERE id = ?1'
  ).bind(id).first();
  if (!target) throw new HttpError(404, 'Not found');
  if (target.role !== 'influencer') throw new HttpError(400, 'Only influencers can be reassigned');

  const adminId = (await env.DB.prepare(
    `SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`).first())?.id ?? user.id;
  const raw = (await jsonBody(request)).parentId;

  // empty, null, or the admin's own id all mean "reports directly to QHT Admin"
  let newParentId = adminId;
  let newParentName = 'QHT Admin';

  if (raw !== null && raw !== undefined && raw !== '' && Number(raw) !== adminId) {
    const head = await env.DB.prepare('SELECT id, role, full_name FROM users WHERE id = ?1')
      .bind(Number(raw)).first();
    if (!head || head.role !== 'head_influencer') {
      throw new HttpError(400, 'Choose a Head Influencer, or QHT Admin');
    }
    if (head.id === id) throw new HttpError(400, 'Someone cannot report to themselves');
    newParentId = head.id;
    newParentName = head.full_name;
  }

  if (newParentId === target.parent_id) {
    return json({ ok: true, unchanged: true, parentName: newParentName });
  }

  const from = target.parent_id
    ? (await env.DB.prepare('SELECT full_name FROM users WHERE id = ?1')
        .bind(target.parent_id).first())?.full_name
    : 'QHT Admin';

  await env.DB.prepare(`UPDATE users SET parent_id = ?1, updated_at = datetime('now') WHERE id = ?2`)
    .bind(newParentId, id).run();
  await audit(env, user.id, 'reassign_user', 'users', id,
    { name: target.full_name, from, to: newParentName });

  return json({ ok: true, parentName: newParentName, from });
}

/* ------------------------------ delete a person ------------------------------ */
/** What disappears if this account goes — shown in the confirmation dialog. */
async function impact({ env, params, user, json }) {
  gate(user);
  assertRole(user, 'admin');

  const id = Number(params.id);
  const u = await env.DB.prepare('SELECT id, role, full_name, parent_id FROM users WHERE id = ?1')
    .bind(id).first();
  if (!u) throw new HttpError(404, 'Not found');

  const { results: children } = await env.DB.prepare(
    'SELECT id, full_name, role FROM users WHERE parent_id = ?1 ORDER BY full_name'
  ).bind(id).all();

  const count = async (sql) => (await env.DB.prepare(sql).bind(id).first())?.n ?? 0;

  return json({
    id: u.id,
    fullName: u.full_name,
    role: u.role,
    submissions: await count('SELECT COUNT(*) n FROM daily_submissions WHERE user_id = ?1'),
    payments: await count('SELECT COUNT(*) n FROM payments WHERE user_id = ?1'),
    releasedAmount: (await env.DB.prepare(
      `SELECT COALESCE(SUM(amount), 0) a FROM payments WHERE user_id = ?1 AND status = 'released'`
    ).bind(id).first())?.a ?? 0,
    hasAgreement: !!(await env.DB.prepare('SELECT id FROM agreements WHERE user_id = ?1 LIMIT 1')
      .bind(id).first()),
    children,
    reassignTo: u.parent_id
      ? await env.DB.prepare('SELECT id, full_name FROM users WHERE id = ?1').bind(u.parent_id).first()
      : null
  });
}

/**
 * Permanently removes a person. Agreements, submissions and payments cascade;
 * the rows that merely *point* at them — who reviewed a photo, who released a
 * payment, audit entries — are detached first so the delete cannot fail on a
 * foreign key. Someone with a team is refused unless reassignChildren is set.
 */
async function remove({ request, env, url, params, user, json }) {
  gate(user);
  assertRole(user, 'admin');

  const id = Number(params.id);
  const u = await env.DB.prepare('SELECT id, role, full_name, parent_id FROM users WHERE id = ?1')
    .bind(id).first();
  if (!u) throw new HttpError(404, 'Not found');

  if (id === user.id) throw new HttpError(400, 'You cannot delete your own account');
  if (u.role === 'admin') throw new HttpError(400, 'Admin accounts cannot be deleted');

  const { results: kids } = await env.DB.prepare('SELECT id FROM users WHERE parent_id = ?1')
    .bind(id).all();
  const b = await jsonBody(request);
  const reassign = b.reassignChildren === true || url.searchParams.get('reassignChildren') === 'true';

  if (kids.length && !reassign) {
    throw new HttpError(409,
      `${u.full_name} still has ${kids.length} influencer(s) under them.`, 'HAS_TEAM');
  }

  // the photos live in R2, not the database, so collect their keys before the cascade
  const { results: shots } = await env.DB.prepare(
    'SELECT photo_path FROM daily_submissions WHERE user_id = ?1').bind(id).all();
  const keys = shots.map(s => s.photo_path).filter(Boolean);
  if (u.id_proof_file) keys.push(u.id_proof_file);

  /* D1 has no BEGIN/COMMIT to hold open across awaits; batch() is its
     equivalent and is applied atomically. */
  const steps = [];
  if (kids.length) {
    steps.push(env.DB.prepare(
      `UPDATE users SET parent_id = ?1, updated_at = datetime('now') WHERE parent_id = ?2`
    ).bind(u.parent_id ?? user.id, id));
  }
  steps.push(
    env.DB.prepare('UPDATE daily_submissions SET reviewed_by = NULL WHERE reviewed_by = ?1').bind(id),
    env.DB.prepare('UPDATE payments SET released_by = NULL WHERE released_by = ?1').bind(id),
    env.DB.prepare('UPDATE audit_log SET actor_id = NULL WHERE actor_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(id)
  );
  await env.DB.batch(steps);

  /* only once the rows are gone, so a failed delete cannot lose the photos —
     and into trash, not away, so a Time Travel restore of the rows can find them */
  for (const key of keys) await discard(env, key, `deleted user ${id}`);

  await audit(env, user.id, 'delete_user', 'users', id,
    { name: u.full_name, role: u.role, reassigned: kids.length });
  return json({ ok: true, deleted: u.full_name, reassigned: kids.length });
}

/* ----------------------------- restore photos (admin) ----------------------------- */
/**
 * The second half of an undo. Restore the database with D1 Time Travel first;
 * then this puts back every trashed photo the restored rows point at. Safe to
 * run any number of times — it only ever copies out of trash, never deletes.
 */
async function restorePhotos({ env, user, json }) {
  gate(user);
  assertRole(user, 'admin');
  const result = await restoreReferenced(env);
  await audit(env, user.id, 'restore_photos', 'r2', null, result);
  return json(result);
}

async function setStatus({ request, env, params, user, json }) {
  gate(user);
  assertRole(user, 'admin');

  const status = (await jsonBody(request)).status;
  if (!['active', 'suspended', 'pending_agreement'].includes(status)) {
    throw new HttpError(400, 'Invalid status');
  }
  if (Number(params.id) === user.id) {
    throw new HttpError(400, 'You cannot change your own status');
  }
  await env.DB.prepare(`UPDATE users SET status = ?1, updated_at = datetime('now') WHERE id = ?2`)
    .bind(status, Number(params.id)).run();
  await audit(env, user.id, 'set_status', 'users', Number(params.id), { status });
  return json({ ok: true });
}

/* Order matters: /users/heads and /users/tree must be matched before /users/:id,
   or "heads" would be read as an id. */
export default [
  ['POST', '/users', register],
  ['GET', '/users', list],
  ['GET', '/users/heads', heads],
  ['GET', '/users/tree', tree],
  ['PATCH', '/users/me', updateSelf],
  ['POST', '/users/restore-photos', restorePhotos],
  ['GET', '/users/:id', one],
  ['PATCH', '/users/:id/token', setToken],
  ['PATCH', '/users/:id/parent', setParent],
  ['GET', '/users/:id/impact', impact],
  ['DELETE', '/users/:id', remove],
  ['PATCH', '/users/:id/status', setStatus]
];
