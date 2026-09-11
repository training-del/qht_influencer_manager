/**
 * Moves the existing data onto Cloudflare: rows into D1, photos into R2.
 *
 *   node scripts/migrate-to-cloudflare.mjs            write the files
 *   node scripts/migrate-to-cloudflare.mjs --photos   upload the photos too
 *
 * ---------------------------------------------------------------------------
 * PASSWORDS CANNOT COME ACROSS
 *
 * Every stored hash is scrypt, which is what node:crypto offered. The Workers
 * runtime has only WebCrypto, and WebCrypto has no scrypt — so those hashes
 * cannot be verified there by any means. There is no migration path for them.
 *
 * So each person gets a fresh temporary password and must_change_pw = 1, which
 * is exactly how the app already onboards someone: they sign in once with the
 * temporary password and are made to choose their own before anything else.
 * The list is written to dist/temporary-passwords.csv for the admin to hand out.
 * ---------------------------------------------------------------------------
 */
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword, FREE_PLAN_ROUNDS } from '../worker/src/auth.js';
import { UPLOADS_DIR } from '../server/lib/config.js';

const DB_FILE = process.env.DB_FILE || 'data/qht.sqlite';
const OUT = 'dist';
const BUCKET = 'qht-proofs-prod';
const uploadPhotos = process.argv.includes('--photos');

mkdirSync(OUT, { recursive: true });
const db = new DatabaseSync(DB_FILE, { readOnly: true });

/** Copies every file under uploads/ into R2, keeping the same key it has in the rows. */
async function uploadAll() {
  const files = [];
  for (const kind of ['proofs', 'idproofs']) {
    const dir = join(UPLOADS_DIR, kind);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) files.push({ key: `${kind}/${file}`, path: join(dir, file) });
  }
  /* Without this every object lands as application/octet-stream, and an <img>
     will not render one — the photo would be there but appear broken. */
  const TYPES = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.heic': 'image/heic'
  };
  const typeOf = key => TYPES[(key.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()]
    || 'application/octet-stream';

  console.log(`\n  uploading ${files.length} photos to ${BUCKET} …`);
  let done = 0;
  for (const { key, path } of files) {
    try {
      execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`,
                           '--file', path, '--content-type', typeOf(key), '--remote'],
                   { cwd: 'worker', stdio: 'pipe', shell: true });
      done++;
      process.stdout.write(`\r  ${done}/${files.length}`);
    } catch (err) {
      console.error(`\n  failed: ${key} — ${String(err.stderr || err).slice(0, 120)}`);
    }
  }
  console.log(`\n  ${done} of ${files.length} uploaded`);
}

/* --------------------------------- helpers --------------------------------- */
const sql = v =>
  v === null || v === undefined ? 'NULL'
    : typeof v === 'number' ? String(v)
    : `'${String(v).replace(/'/g, "''")}'`;

const insert = (table, row) =>
  `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(sql).join(', ')});`;

const rows = table => db.prepare(`SELECT * FROM ${table}`).all();

/** A readable password someone can be told over the phone without spelling it. */
const tempPassword = () => {
  const words = ['tiger', 'mango', 'river', 'cloud', 'lotus', 'amber', 'coral', 'ivory'];
  const w = words[Math.floor(Math.random() * words.length)];
  const n = String(Math.floor(Math.random() * 900) + 100);
  return `${w[0].toUpperCase()}${w.slice(1)}@${n}`;      // Mango@417 — passes the rules
};

/* ---------------------------------- users ---------------------------------- */
/* Parents must exist before their children, or the self-reference fails. Walk
   the tree rather than trusting that ids happen to be in the right order. */
const all = rows('users');
const ordered = [];
const placed = new Set();
let remaining = [...all];
while (remaining.length) {
  const next = remaining.filter(u => u.parent_id === null || placed.has(u.parent_id));
  if (!next.length) {
    console.error('Cycle in users.parent_id — cannot order:', remaining.map(u => u.id));
    process.exit(1);
  }
  for (const u of next) { ordered.push(u); placed.add(u.id); }
  remaining = remaining.filter(u => !placed.has(u.id));
}

/**
 * Temporary passwords are random per run, so regenerating after the import has
 * already happened would leave the handout file describing passwords that are
 * not in the database. --photos only uploads; it must not rewrite anything.
 */
if (uploadPhotos && existsSync(join(OUT, 'd1-import.sql'))) {
  await uploadAll();
  db.close();
  process.exit(0);
}

const credentials = [];
const userStatements = [];
for (const u of ordered) {
  const temp = tempPassword();
  credentials.push({
    id: u.id, name: u.full_name, role: u.role,
    phone: `${u.country_code || '+91'} ${u.phone}`, password: temp
  });
  userStatements.push(insert('users', {
    ...u,
    password_hash: await hashPassword(temp, FREE_PLAN_ROUNDS),
    must_change_pw: 1
  }));
}

/* ---------------------------- referential integrity ---------------------------- */
/**
 * The source database is not clean: it holds agreements belonging to users that
 * no longer exist, left behind when foreign keys were briefly switched off
 * during a wipe. D1 enforces them, so the import would fail part-way through and
 * leave a half-populated database.
 *
 * Rows that cannot stand alone are dropped; references that are merely optional
 * — who reviewed a photo, who released a payment — are blanked instead, which
 * loses a name but keeps the record. Everything skipped is reported, never
 * silently discarded.
 */
const ids = table => new Set(rows(table).map(r => r.id));
const userIds = ids('users');
const versionIds = ids('agreement_versions');
const skipped = [];

const keepIf = (table, list, ok, describe) => list.filter(r => {
  if (ok(r)) return true;
  skipped.push(`${table} #${r.id}: ${describe(r)}`);
  return false;
});

/** Blanks an optional reference that points at something no longer there. */
const detach = (r, field) =>
  (r[field] !== null && r[field] !== undefined && !userIds.has(r[field]))
    ? { ...r, [field]: null } : r;

const agreements = keepIf('agreements', rows('agreements'),
  r => userIds.has(r.user_id) && versionIds.has(r.version_id),
  r => `user ${r.user_id} / version ${r.version_id} no longer exists`);

const submissions = keepIf('daily_submissions', rows('daily_submissions'),
  r => userIds.has(r.user_id),
  r => `user ${r.user_id} no longer exists`
).map(r => detach(r, 'reviewed_by'));

const payments = keepIf('payments', rows('payments'),
  r => userIds.has(r.user_id),
  r => `user ${r.user_id} no longer exists`
).map(r => detach(r, 'released_by'));

const auditLog = rows('audit_log').map(r => detach(r, 'actor_id'));

/* ------------------------------- everything else ------------------------------- */
const statements = [
  '-- Generated by scripts/migrate-to-cloudflare.mjs. Apply once, to an empty database.',
  '-- Passwords are NOT the originals: see dist/temporary-passwords.csv.',
  '',
  '-- users (parents before children)',
  ...userStatements,
  '',
  '-- agreement versions',
  ...rows('agreement_versions').map(r => insert('agreement_versions', r)),
  '',
  '-- accepted agreements',
  ...agreements.map(r => insert('agreements', r)),
  '',
  '-- daily submissions',
  ...submissions.map(r => insert('daily_submissions', r)),
  '',
  '-- payments',
  ...payments.map(r => insert('payments', r)),
  '',
  '-- audit trail',
  ...auditLog.map(r => insert('audit_log', r))
];

writeFileSync(join(OUT, 'd1-import.sql'), statements.join('\n') + '\n');

writeFileSync(join(OUT, 'temporary-passwords.csv'),
  ['id,name,role,phone,temporary_password',
   ...credentials.map(c => [c.id, c.name, c.role, c.phone, c.password]
     .map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
  ].join('\r\n') + '\r\n');

/* --------------------------------- photos --------------------------------- */
/* The object keys are the paths already stored in the rows, so nothing in the
   database has to be rewritten — proofs/x.jpg stays proofs/x.jpg. */
const keys = [];
for (const kind of ['proofs', 'idproofs']) {
  const dir = join(UPLOADS_DIR, kind);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir)) keys.push({ key: `${kind}/${file}`, path: join(dir, file) });
}

const referenced = new Set([
  ...submissions.map(r => r.photo_path),
  ...rows('users').map(r => r.id_proof_file)
].filter(Boolean));

const orphans = keys.filter(k => !referenced.has(k.key));
const missing = [...referenced].filter(key => !keys.some(k => k.key === key));

/* What is being imported, next to what was in the source — so a row that got
   dropped shows up here rather than only in the skipped list below. */
const tally = (label, taken, source) =>
  console.log(`  ${label.padEnd(20)}${String(taken).padStart(4)}` +
    (taken === source ? '' : `   of ${source}`));

console.log('');
tally('users', ordered.length, rows('users').length);
tally('agreements', agreements.length, rows('agreements').length);
tally('daily submissions', submissions.length, rows('daily_submissions').length);
tally('payments', payments.length, rows('payments').length);
tally('audit entries', auditLog.length, rows('audit_log').length);
tally('photo files', keys.length, keys.length);
if (orphans.length) console.log(`    ${orphans.length} not referenced by any row (kept anyway)`);
if (missing.length) {
  console.log(`\n  WARNING: ${missing.length} row(s) point at a file that is not on disk:`);
  for (const m of missing.slice(0, 5)) console.log('    ' + m);
}

if (skipped.length) {
  console.log(`\n  SKIPPED ${skipped.length} row(s) pointing at something no longer in the database:`);
  for (const line of skipped.slice(0, 10)) console.log('    ' + line);
  if (skipped.length > 10) console.log(`    … and ${skipped.length - 10} more`);
  console.log('  Leftovers from deleted accounts. D1 enforces foreign keys, so');
  console.log('  importing them would fail part-way through and leave a half-full database.');
}

console.log(`\n  wrote ${OUT}/d1-import.sql`);
console.log(`  wrote ${OUT}/temporary-passwords.csv   (hand these out, then delete the file)`);

if (uploadPhotos) {
  await uploadAll();
} else {
  console.log(`\n  Next:`);
  console.log(`    cd worker && npx wrangler d1 execute qht-influencer --remote --file=../dist/d1-import.sql`);
  console.log(`    node scripts/migrate-to-cloudflare.mjs --photos`);
}

db.close();
