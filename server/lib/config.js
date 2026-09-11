/**
 * Every environment-dependent setting, in one place.
 *
 * Development keeps working with no configuration at all — the defaults point
 * at folders inside the repo. Production must be told explicitly where things
 * live, and must supply its own session secret; a deployment that forgets is
 * stopped at startup rather than running with a secret that is public.
 */
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** Resolves a configured path against the repo root, so relative values work. */
const resolve = (value, fallback) => {
  const p = value?.trim() || fallback;
  return isAbsolute(p) ? p : join(ROOT, p);
};

/* ------------------------------- where data lives ------------------------------- */
/* One knob for a hosted deployment: point DATA_DIR at the persistent volume and
   the database and the uploaded photos both follow it. Either can still be
   overridden on its own. */
export const DATA_DIR = resolve(process.env.DATA_DIR, 'data');
export const DB_FILE = resolve(process.env.DB_FILE, join(DATA_DIR, 'qht.sqlite'));
export const UPLOADS_DIR = resolve(process.env.UPLOADS_DIR, join(DATA_DIR, '..', 'uploads'));

mkdirSync(dirname(DB_FILE), { recursive: true });
mkdirSync(UPLOADS_DIR, { recursive: true });

/* --------------------------------- ports --------------------------------- */
export const PORT = Number(process.env.PORT) || 4000;
export const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 4443;
export const CERT_DIR = resolve(process.env.CERT_DIR, 'certs');

/* --------------------------------- secret --------------------------------- */
const DEV_SECRET = 'qht-dev-secret-change-in-production';

/**
 * Session tokens are signed with this. Anyone holding it can mint a token for
 * any account, so the development value — which is committed to the repo and
 * therefore public — must never reach a real deployment.
 */
function sessionSecret() {
  const supplied = process.env.SESSION_SECRET?.trim();

  if (IS_PRODUCTION) {
    if (!supplied) {
      console.error(`
  SESSION_SECRET is not set.

  Session tokens are signed with it, so without one this deployment would fall
  back to a value that is published in the source. Generate one and set it:

      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
`);
      process.exit(1);
    }
    if (supplied === DEV_SECRET) {
      console.error('\n  SESSION_SECRET is still the development value. Generate a real one.\n');
      process.exit(1);
    }
    if (supplied.length < 32) {
      console.error(`\n  SESSION_SECRET is only ${supplied.length} characters. Use at least 32.\n`);
      process.exit(1);
    }
    return supplied;
  }

  return supplied || DEV_SECRET;
}

export const SESSION_SECRET = sessionSecret();
