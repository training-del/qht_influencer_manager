/**
 * Stamps a build id into the service worker, so a deploy actually reaches
 * people's phones.
 *
 * A browser installs a new service worker only when that file's bytes differ
 * from the one it already has. Without this the file never changed, so the
 * cache kept its old name and the previously cached JavaScript stayed valid —
 * a deploy would sit there unused. Run before every `wrangler pages deploy`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SW = 'public/sw.js';
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);   // 20260910T093012 -> 20260910093012

const before = readFileSync(SW, 'utf8');
const after = before.replace(/^const VERSION = '.*';$/m, `const VERSION = '${stamp}';`);

if (after === before) {
  console.error(`  could not find the VERSION line in ${SW} — the cache would not be invalidated`);
  process.exit(1);
}

writeFileSync(SW, after);
console.log(`  service worker stamped ${stamp}`);
