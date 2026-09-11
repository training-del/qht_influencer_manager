/**
 * Versioned schema migrations.
 *
 * Replaces the previous approach — CREATE TABLE IF NOT EXISTS plus an ad-hoc
 * addColumnIfMissing() — which could only ever add a column. A rename, a drop,
 * a changed constraint or a data backfill had nowhere to live, and nothing
 * recorded which changes a given database had actually seen.
 *
 * Each file in server/migrations/ is applied once, in filename order, inside a
 * transaction, and its name is recorded. To change the schema, add a file:
 *
 *     server/migrations/003_add_something.sql
 *
 * Never edit a migration that has already run anywhere — write the next one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, '..', 'migrations');

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {(msg: string) => void} [log]
 */
export function migrate(db, log = () => {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

  const files = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
  const done = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name)
  );

  /* A database created before migrations existed already has the full schema,
     so replaying 001 would fail on tables that are there. If the users table
     exists but nothing is recorded, treat what is on disk as the baseline. */
  if (!done.size) {
    const built = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'`
    ).get();
    if (built) {
      const mark = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');
      for (const f of files) { mark.run(f); done.add(f); }
      log(`existing database adopted at ${files.at(-1)} (nothing replayed)`);
      return { applied: [], baselined: files };
    }
  }

  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;

    const sql = readFileSync(join(DIR, file), 'utf8');
    /* PRAGMA journal_mode cannot run inside a transaction, and the wrapper is
       only worth having for migrations that change more than one thing. */
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
    applied.push(file);
    log(`applied ${file}`);
  }

  return { applied, baselined: [] };
}
