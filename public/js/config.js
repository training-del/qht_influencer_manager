/**
 * Where the API lives.
 *
 * Two very different situations, and the page can tell them apart on its own:
 *
 *   In a browser — the pages and the API come from the same place, whether
 *   that is the Express server or Cloudflare Pages. Same origin, so no host is
 *   needed and none is used.
 *
 *   In the Android app — the screens are bundled inside the APK and the WebView
 *   serves them from https://localhost. There is no API there, so it has to be
 *   named. This is also why the app works on any network: nothing points at a
 *   laptop, only at Cloudflare.
 *
 * Capacitor puts a global on the page, which is the reliable way to know which
 * of the two we are in — the URL alone cannot tell you.
 */

/** Set once, after the first `wrangler pages deploy` prints the address. */
export const PACKAGED_API = 'https://qht-influencer.pages.dev';

const insideApp = typeof window !== 'undefined' && !!window.Capacitor;

export const API_BASE = insideApp ? PACKAGED_API : '';

/** Absolute URL for an API path, or a same-origin one in a browser. */
export const apiUrl = path => API_BASE + path;
