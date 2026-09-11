import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, ROOT } from './config.js';
import { migrate } from './migrate.js';

export { ROOT };

export const db = new DatabaseSync(DB_FILE);

/* Connection settings, not schema — these have to be set on every connection,
   so they live here rather than in a migration that runs once. */
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/* Wait rather than fail if another process holds the write lock — a second
   process (a backup, a seed run) otherwise dies with "database is locked". */
db.exec('PRAGMA busy_timeout = 5000');

migrate(db, msg => console.log(`  migration: ${msg}`));

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function audit(actorId, action, entity, entityId, meta) {
  run(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, meta) VALUES (?,?,?,?,?)`,
    actorId ?? null, action, entity ?? null, entityId ?? null,
    meta ? JSON.stringify(meta) : null
  );
}

/**
 * All descendant ids of a user (their whole downline), excluding themselves.
 * Recursive CTE walks users.parent_id.
 */
export function descendantIds(userId) {
  return all(
    `WITH RECURSIVE tree(id) AS (
       SELECT id FROM users WHERE parent_id = ?
       UNION ALL
       SELECT u.id FROM users u JOIN tree t ON u.parent_id = t.id
     ) SELECT id FROM tree`,
    userId
  ).map(r => r.id);
}

/** ids a viewer may act on: admin -> everyone else; head -> own downline; influencer -> none */
export function visibleUserIds(viewer) {
  if (viewer.role === 'admin') return all(`SELECT id FROM users WHERE id <> ?`, viewer.id).map(r => r.id);
  if (viewer.role === 'head_influencer') return descendantIds(viewer.id);
  return [];
}

export function canView(viewer, targetId) {
  if (viewer.id === targetId) return true;
  return visibleUserIds(viewer).includes(targetId);
}
