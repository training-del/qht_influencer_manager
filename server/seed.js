/**
 * Seeds the QHT admin, the active agreement version, and a demo hierarchy
 * with submissions/payments so every screen has something real to show.
 *   node server/seed.js          -> seed only if empty
 *   node server/seed.js --reset  -> wipe and reseed
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { db, get, run, ROOT } from './lib/db.js';
import { UPLOADS_DIR } from './lib/config.js';
import { hashPassword } from './lib/auth.js';

const RESET = process.argv.includes('--reset');
const PROOFS = join(UPLOADS_DIR, 'proofs');
mkdirSync(PROOFS, { recursive: true });

if (RESET) {
  // users.parent_id is self-referencing with ON DELETE RESTRICT, so a bulk wipe
  // has to run with FK enforcement off rather than in dependency order.
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['audit_log', 'payments', 'daily_submissions', 'agreements', 'agreement_versions', 'users']) {
    db.exec(`DELETE FROM ${t}`);
  }
  db.exec(`DELETE FROM sqlite_sequence`);
  db.exec('PRAGMA foreign_keys = ON');
  rmSync(PROOFS, { recursive: true, force: true });
  mkdirSync(PROOFS, { recursive: true });
  console.log('  reset: existing data cleared');
}

if (get(`SELECT id FROM users LIMIT 1`) && !RESET) {
  console.log('  database already seeded - run "npm run reset" to rebuild');
  process.exit(0);
}

const dateStr = offset => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toLocaleDateString('en-CA');
};

/* ----------------------------- agreement version ----------------------------- */
const CLAUSES = [
  { key: 'token',      required: true,  title: 'Fixed token amount',
    body: 'QHT will pay me a fixed token amount for each payout cycle, as set out in my profile, subject to the compliance terms below.' },
  { key: 'consume',    required: true,  title: 'Daily consumption of the product (dava)',
    body: 'I agree to consume the product ("dava") supplied by QHT every day, exactly as directed, for the full duration of this agreement.' },
  { key: 'photo',      required: true,  title: 'Daily photo proof',
    body: 'I agree to upload one clear photograph each day as proof of consumption. The date and time are recorded automatically with each upload.' },
  { key: 'duration',   required: true,  title: 'Duration and frequency',
    body: 'This commitment runs for 90 days from the date of acceptance and requires one submission on every calendar day.' },
  { key: 'compliance', required: true,  title: 'Consequences of non-compliance',
    body: 'Missed days reduce my compliance rate. If compliance falls below 80% in a payout cycle, QHT may withhold, reduce or place on hold the token amount for that cycle, and may end this agreement.' },
  { key: 'media',      required: true,  title: 'Use of submitted photos',
    body: 'I permit QHT to store and review my submitted photographs for verification and compliance purposes only.' },
  { key: 'accurate',   required: true,  title: 'Truthful submissions',
    body: 'I confirm that every photo I submit is taken by me on the day of submission, and that submitting false or reused proof may result in rejection of payment and removal from the programme.' }
];

run(`INSERT INTO agreement_versions (version, title, summary, clauses_json, duration_days, min_compliance, is_active)
     VALUES (?,?,?,?,?,?,1)`,
  'v1.0', 'QHT Influencer Participation Agreement',
  'Please read each term and tick every box. You cannot access your dashboard until all terms are accepted.',
  JSON.stringify(CLAUSES), 90, 80);
const versionId = get(`SELECT id FROM agreement_versions WHERE version = 'v1.0'`).id;

/* ---------------------------------- people ---------------------------------- */
function addUser(u) {
  const info = run(
    `INSERT INTO users (role, parent_id, full_name, phone, country_code, email, address, id_proof_type, id_proof_number,
       bank_account_name, bank_account_no, bank_ifsc, upi_id, password_hash, must_change_pw,
       status, token_amount, payout_cycle, next_payout_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`,
    u.role, u.parent_id ?? null, u.full_name, u.phone, u.country_code ?? '+91', u.email, u.address ?? null,
    u.id_proof_type ?? 'aadhaar', u.id_proof_number ?? null,
    u.full_name, u.bank ?? null, u.ifsc ?? null, u.upi ?? null,
    hashPassword(u.password), u.status ?? 'pending_agreement',
    u.token ?? 0, u.cycle ?? 'monthly', u.next_payout ?? dateStr(-14));
  return info.lastInsertRowid;
}

function acceptAgreement(userId, name, token, daysAgo) {
  run(`INSERT INTO agreements (user_id, version_id, version_label, accepted_at, signature_name,
         accepted_clauses, token_amount_snap, ip_address, user_agent)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    userId, versionId, 'v1.0', `${dateStr(daysAgo)} 09:15:00`, name,
    JSON.stringify(CLAUSES.map(c => c.key)), token, '127.0.0.1', 'seed');
  run(`UPDATE users SET status = 'active' WHERE id = ?`, userId);
}

const adminId = addUser({
  role: 'admin', full_name: 'QHT Admin', phone: '9000000001', email: 'admin@qht.com',
  address: 'QHT Clinic HQ', password: 'admin123', status: 'active', token: 0
});

const head1 = addUser({
  role: 'head_influencer', parent_id: adminId, full_name: 'Rohit Sharma', phone: '9000000010',
  email: 'rohit@example.com', address: 'Andheri West, Mumbai', password: 'head123',
  token: 15000, bank: 'XXXXXX4412', ifsc: 'HDFC0001234', upi: 'rohit@upi', id_proof_number: 'XXXX-XXXX-4412'
});
acceptAgreement(head1, 'Rohit Sharma', 15000, 26);

const head2 = addUser({
  role: 'head_influencer', parent_id: adminId, full_name: 'Neha Kapoor', phone: '9000000011',
  email: 'neha@example.com', address: 'Koramangala, Bengaluru', password: 'head123',
  token: 15000, upi: 'neha@upi', id_proof_number: 'XXXX-XXXX-7781'
});   // deliberately left pending_agreement to demo the T&C gate

const team = [
  { name: 'Aarav Mehta',   phone: '9000000020', parent: head1,   token: 5000, accepted: 24, pattern: 'good'    },
  { name: 'Priya Nair',    phone: '9000000021', parent: head1,   token: 5000, accepted: 20, pattern: 'spotty'  },
  { name: 'Karan Verma',   phone: '9000000022', parent: head1,   token: 4000, accepted: null, pattern: 'none'  },
  { name: 'Sneha Iyer',    phone: '9000000023', parent: adminId, token: 6000, accepted: 22, pattern: 'good'    },
  { name: 'Vikram Singh',  phone: '9000000024', parent: adminId, token: 4500, accepted: 15, pattern: 'poor'    }
];

const proofSvg = (name, date) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640">
     <rect width="480" height="640" fill="#1f2937"/>
     <circle cx="240" cy="250" r="90" fill="#0ea5a4" opacity="0.85"/>
     <text x="240" y="265" font-family="sans-serif" font-size="64" fill="#fff" text-anchor="middle">DAVA</text>
     <text x="240" y="430" font-family="sans-serif" font-size="26" fill="#fff" text-anchor="middle">${name}</text>
     <text x="240" y="470" font-family="sans-serif" font-size="22" fill="#9ca3af" text-anchor="middle">${date}</text>
     <text x="240" y="600" font-family="sans-serif" font-size="16" fill="#6b7280" text-anchor="middle">proof of consumption</text>
   </svg>`;

const PATTERNS = {
  good:   d => d % 11 !== 0,                       // ~91%
  spotty: d => d % 3 !== 0,                        // ~67%
  poor:   d => d % 2 === 0 && d % 5 !== 0,         // ~40%
  none:   () => false
};

for (const t of team) {
  const id = addUser({
    role: 'influencer', parent_id: t.parent, full_name: t.name, phone: t.phone,
    email: `${t.name.split(' ')[0].toLowerCase()}@example.com`,
    address: 'India', password: 'pass123', token: t.token,
    upi: `${t.name.split(' ')[0].toLowerCase()}@upi`, id_proof_number: 'XXXX-XXXX-' + t.phone.slice(-4)
  });
  if (t.accepted === null) continue;               // stays pending_agreement
  acceptAgreement(id, t.name, t.token, t.accepted);

  for (let d = t.accepted - 1; d >= 0; d--) {
    if (!PATTERNS[t.pattern](d)) continue;         // missed day
    const date = dateStr(d);
    const file = `seed-${id}-${date}.svg`;
    writeFileSync(join(PROOFS, file), proofSvg(t.name, date));

    // recent days stay pending review; older days are decided
    const status = d <= 2 ? 'pending' : (d % 9 === 0 ? 'rejected' : 'approved');
    run(`INSERT INTO daily_submissions (user_id, submission_date, photo_path, note, captured_at,
           status, reviewed_by, reviewed_at, review_note)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      id, date, `proofs/${file}`, d % 7 === 0 ? 'Taken after breakfast' : null,
      `${date} 08:${String(10 + (d % 45)).padStart(2, '0')}:00`,
      status, status === 'pending' ? null : adminId,
      status === 'pending' ? null : `${date} 20:00:00`,
      status === 'rejected' ? 'Photo unclear - product not visible' : null);
  }

  run(`INSERT INTO payments (user_id, period_start, period_end, amount, compliance_pct, status,
         released_at, released_by, reference_no, note)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, dateStr(t.accepted), dateStr(t.accepted - 30 > 0 ? t.accepted - 30 : 1), t.token,
    null, 'released', `${dateStr(2)} 12:00:00`, adminId, 'UTR' + (100000 + id), 'Cycle 1 payout');
  run(`INSERT INTO payments (user_id, period_start, period_end, amount, compliance_pct, status, note)
       VALUES (?,?,?,?,?,?,?)`,
    id, dateStr(14), dateStr(-14), t.token, null,
    t.pattern === 'poor' ? 'on_hold' : 'pending',
    t.pattern === 'poor' ? 'Held - compliance below 80%' : 'Cycle 2, awaiting release');
}

run(`INSERT INTO payments (user_id, period_start, period_end, amount, compliance_pct, status, note)
     VALUES (?,?,?,?,?,?,?)`, head1, dateStr(26), dateStr(-4), 15000, null, 'pending', 'Head influencer cycle payout');

const n = get(`SELECT
    (SELECT COUNT(*) FROM users) u,
    (SELECT COUNT(*) FROM daily_submissions) s,
    (SELECT COUNT(*) FROM payments) p`);

console.log(`
  Seeded: ${n.u} users, ${n.s} submissions, ${n.p} payments

  Login credentials (phone / password)
  ------------------------------------------------------------
  QHT Admin         9000000001 / admin123
  Head Influencer   9000000010 / head123     (Rohit Sharma, active)
  Head Influencer   9000000011 / head123     (Neha Kapoor, must accept T&C)
  Influencer        9000000020 / pass123     (Aarav Mehta, under Rohit)
  Influencer        9000000022 / pass123     (Karan Verma, must accept T&C)
  Influencer        9000000023 / pass123     (Sneha Iyer, under Admin)
`);
