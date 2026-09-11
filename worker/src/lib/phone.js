/* Copied verbatim from server/lib/phone.js — pure functions, no Node APIs, so
   they run unchanged on Workers. The browser has its own copy of these rules in
   public/js/api.js; all three must agree. */
/**
 * Phone rules for the programme.
 *
 * Numbers are stored as the 10-digit national number in `users.phone`, with the
 * dialling code kept separately in `users.country_code`. Keeping them apart means
 * the uniqueness constraint and every login lookup stay on one clean 10-digit key.
 */

export const DEFAULT_COUNTRY = '+91';

/** Dialling codes offered in the registration form. */
export const COUNTRY_CODES = [
  { code: '+91', label: 'India (+91)' },
  { code: '+971', label: 'UAE (+971)' },
  { code: '+44', label: 'UK (+44)' },
  { code: '+1', label: 'USA / Canada (+1)' },
  { code: '+65', label: 'Singapore (+65)' }
];

/**
 * Reduce anything a person might type to bare digits, then drop a country code
 * or trunk prefix if they included one: +91 98765 43210, 09876543210,
 * 91-9876543210 and 9876543210 all normalise to the same 10 digits.
 */
export function normalisePhone(input, countryCode = DEFAULT_COUNTRY) {
  let d = String(input ?? '').replace(/\D/g, '');
  const cc = String(countryCode || DEFAULT_COUNTRY).replace(/\D/g, '');

  // Strip a prefix only when doing so leaves exactly 10 digits, so a genuine
  // typo like 91234567890 is reported as 11 digits rather than silently trimmed.
  if (cc && d.length === cc.length + 10 && d.startsWith(cc)) d = d.slice(cc.length);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

/**
 * Validates the normalised number. Exactly 10 digits everywhere; on +91 the
 * first digit must also be 6-9, which is what Indian mobile numbering allows.
 */
export function validatePhone(input, countryCode = DEFAULT_COUNTRY) {
  const phone = normalisePhone(input, countryCode);

  if (!phone) return { ok: false, error: 'Phone number is required' };
  if (!/^\d+$/.test(phone)) return { ok: false, error: 'Phone number must contain digits only' };
  if (phone.length !== 10) {
    return { ok: false, error: `Phone number must be exactly 10 digits — you entered ${phone.length}` };
  }
  if (countryCode === '+91' && !/^[6-9]/.test(phone)) {
    return { ok: false, error: 'An Indian mobile number must start with 6, 7, 8 or 9' };
  }
  return { ok: true, phone };
}

export function validateCountryCode(code) {
  const c = String(code || DEFAULT_COUNTRY).trim();
  return /^\+\d{1,4}$/.test(c) ? c : null;
}

/** Display form, e.g. "+91 98765 43210". */
export const formatPhone = (phone, countryCode = DEFAULT_COUNTRY) =>
  `${countryCode} ${String(phone || '').replace(/(\d{5})(\d{5})/, '$1 $2')}`.trim();
