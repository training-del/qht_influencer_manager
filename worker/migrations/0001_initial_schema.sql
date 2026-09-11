-- QHT Influencer Manager :: initial schema for Cloudflare D1
--
-- D1 is SQLite, so this is the same schema the app already runs on. The two
-- migrations from the Express version are collapsed into one here because a D1
-- database starts empty; there is no existing database to migrate in place.
--
-- Applied with:  npx wrangler d1 migrations apply qht-influencer

-- ---------------------------------------------------------------
-- users : single self-referencing table holds the whole hierarchy
--   admin            -> parent_id NULL
--   head_influencer  -> parent_id = admin id
--   influencer       -> parent_id = admin id OR head_influencer id
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  role              TEXT NOT NULL CHECK (role IN ('admin','head_influencer','influencer')),
  parent_id         INTEGER REFERENCES users(id) ON DELETE RESTRICT,

  full_name         TEXT NOT NULL,
  phone             TEXT NOT NULL UNIQUE,   -- 10-digit national number, no country code
  country_code      TEXT NOT NULL DEFAULT '+91',
  email             TEXT UNIQUE,
  address           TEXT,

  id_proof_type     TEXT,            -- aadhaar | pan | passport | dl | voter
  id_proof_number   TEXT,
  id_proof_file     TEXT,            -- relative path under /uploads

  bank_account_name TEXT,
  bank_account_no   TEXT,
  bank_ifsc         TEXT,
  upi_id            TEXT,

  password_hash     TEXT NOT NULL,
  must_change_pw    INTEGER NOT NULL DEFAULT 0,

  -- pending_agreement : registered but T&C not yet accepted -> no dashboard access
  status            TEXT NOT NULL DEFAULT 'pending_agreement'
                    CHECK (status IN ('pending_agreement','active','suspended')),

  token_amount      REAL NOT NULL DEFAULT 0,     -- payout per period
  payout_cycle      TEXT NOT NULL DEFAULT 'monthly'
                    CHECK (payout_cycle IN ('weekly','fortnightly','monthly')),
  next_payout_date  TEXT,

  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_parent ON users(parent_id);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role);

-- ---------------------------------------------------------------
-- agreement_versions : versioned T&C. Clauses stored as JSON so the
-- acceptance screen renders one checkbox per clause.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreement_versions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  version           TEXT NOT NULL UNIQUE,       -- e.g. 'v1.0'
  title             TEXT NOT NULL,
  summary           TEXT,
  clauses_json      TEXT NOT NULL,              -- [{key,title,body,required}]
  duration_days     INTEGER NOT NULL DEFAULT 90,
  min_compliance    INTEGER NOT NULL DEFAULT 80,-- % of days required for full payout
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------
-- agreements : one accepted agreement per user per version
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreements (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version_id        INTEGER NOT NULL REFERENCES agreement_versions(id),
  version_label     TEXT NOT NULL,
  accepted_at       TEXT NOT NULL DEFAULT (datetime('now')),
  signature_name    TEXT NOT NULL,              -- typed full name = e-signature
  accepted_clauses  TEXT NOT NULL,              -- JSON array of clause keys ticked
  token_amount_snap REAL NOT NULL DEFAULT 0,    -- token amount agreed at accept time
  ip_address        TEXT,
  user_agent        TEXT,
  UNIQUE (user_id, version_id)
);
CREATE INDEX IF NOT EXISTS idx_agreements_user ON agreements(user_id);

-- ---------------------------------------------------------------
-- daily_submissions : one proof photo per influencer per calendar day
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_submissions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submission_date   TEXT NOT NULL,              -- YYYY-MM-DD (local day)
  photo_path        TEXT NOT NULL,
  note              TEXT,
  captured_at       TEXT NOT NULL DEFAULT (datetime('now')),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','flagged')),
  reviewed_by       INTEGER REFERENCES users(id),
  reviewed_at       TEXT,
  review_note       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, submission_date)
);
CREATE INDEX IF NOT EXISTS idx_sub_user_date ON daily_submissions(user_id, submission_date);
CREATE INDEX IF NOT EXISTS idx_sub_status    ON daily_submissions(status);

-- ---------------------------------------------------------------
-- payments : token payouts per period
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start      TEXT NOT NULL,
  period_end        TEXT NOT NULL,
  amount            REAL NOT NULL,
  compliance_pct    REAL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','on_hold','released')),
  released_at       TEXT,
  released_by       INTEGER REFERENCES users(id),
  reference_no      TEXT,
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pay_user ON payments(user_id);

-- ---------------------------------------------------------------
-- audit_log : who did what (registrations, reviews, payouts)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id          INTEGER REFERENCES users(id),
  action            TEXT NOT NULL,
  entity            TEXT,
  entity_id         INTEGER,
  meta              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
