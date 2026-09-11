/* Copied verbatim from server/lib/password.js — pure functions, no Node APIs, so
   they run unchanged on Workers. The browser has its own copy of these rules in
   public/js/api.js; all three must agree. */
/**
 * Policy for passwords a person chooses for themselves.
 *
 * Deliberately not applied to the temporary password an admin or head
 * influencer hands over at registration — that one is typed once and must be
 * replaced at first login anyway.
 */
export const MIN_LENGTH = 8;

export const RULES = [
  { key: 'len',     label: `At least ${MIN_LENGTH} characters`,        test: v => v.length >= MIN_LENGTH },
  { key: 'letter',  label: 'Contains a letter',                        test: v => /[A-Za-z]/.test(v) },
  { key: 'number',  label: 'Contains a number',                        test: v => /\d/.test(v) },
  { key: 'special', label: 'Contains a special character (! @ # $ …)', test: v => /[^A-Za-z0-9]/.test(v) }
];

/** Returns the first unmet rule, or null when the password passes. */
export function checkPassword(value) {
  const v = String(value ?? '');
  const failed = RULES.find(r => !r.test(v));
  return failed ? { ok: false, error: `Password must meet: ${failed.label.toLowerCase()}`, rule: failed.key } : { ok: true };
}
