-- Push notifications for the Android app (Firebase Cloud Messaging).
--
-- device_tokens: one row per app install that allowed notifications. A token
--   names an install, not a person — if someone else signs in on the same
--   phone, the row moves to them (token is UNIQUE). Deleting a user deletes
--   their devices.
--
-- notification_log: what was sent to whom on which day (IST), so a scheduled
--   run that repeats never sends the same reminder twice.

CREATE TABLE IF NOT EXISTS device_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token        TEXT    NOT NULL UNIQUE,
  platform     TEXT    NOT NULL DEFAULT 'android',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);

CREATE TABLE IF NOT EXISTS notification_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     TEXT    NOT NULL,   -- proof_reminder | review_summary_noon | review_summary_evening
  day      TEXT    NOT NULL,   -- YYYY-MM-DD, Indian time
  sent_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, kind, day)
);
