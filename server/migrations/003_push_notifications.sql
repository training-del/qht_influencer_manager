-- Push notifications for the Android app — the same tables as the Worker's
-- worker/migrations/0002_push_notifications.sql, so the local server can take
-- a device registration too. The sending itself only runs on Cloudflare.

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
  kind     TEXT    NOT NULL,
  day      TEXT    NOT NULL,
  sent_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, kind, day)
);
