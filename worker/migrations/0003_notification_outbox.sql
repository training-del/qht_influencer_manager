-- Notifications caused by something someone did — today, a photo being
-- rejected. The API queues them here; the reminders Worker's every-minute run
-- (worker/src/cron.js, runOutbox) sends them, so they arrive within a minute
-- without the website needing its own copy of the Firebase key.
--
-- The message is written at send time from the submission as it is then: a
-- rejection changed back to approved before the minute is up sends nothing.

CREATE TABLE IF NOT EXISTS notification_outbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL,                -- proof_rejected
  submission_id INTEGER REFERENCES daily_submissions(id) ON DELETE CASCADE,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  attempts      INTEGER NOT NULL DEFAULT 0,      -- gives up after 5
  sent_at       TEXT                              -- NULL = still to send
);
CREATE INDEX IF NOT EXISTS idx_outbox_unsent ON notification_outbox(sent_at, id);
