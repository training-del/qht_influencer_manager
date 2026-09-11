/**
 * The programme runs on Indian time.
 *
 * A Worker's clock is UTC, so `new Date().toLocaleDateString()` there gives the
 * UTC date — which only turns over at 05:30 IST. Between midnight and 05:30 an
 * influencer's photo was filed under yesterday, and a phone asking for "today"
 * was refused as a future date. Every calendar day the server reasons about
 * comes from here instead.
 *
 * Timestamps (captured_at, created_at …) stay UTC in the database — SQLite's
 * datetime('now') — and are converted to IST only when shown.
 */
export const TIME_ZONE = 'Asia/Kolkata';

/** YYYY-MM-DD for the given instant (default now), on Indian time. */
export const todayIST = (at = new Date()) => at.toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
