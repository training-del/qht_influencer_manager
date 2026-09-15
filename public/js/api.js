/* Shared API client + tiny DOM helpers used by every screen. */

import { apiUrl } from '/js/config.js';
// light / dark mode: every page that uses the API gets the switch working
import { THEME_BUTTON } from '/js/theme.js';

const TOKEN_KEY = 'qht_token';
/** this phone's notification token, once registered (see push.js) */
export const PUSH_KEY = 'qht_push_token';

export const auth = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  set token(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); },
  logout() {
    /* The phone stops getting this person's reminders the moment they sign
       out. keepalive lets the request finish while the page is leaving. */
    const push = localStorage.getItem(PUSH_KEY);
    if (push && this.token) {
      fetch(apiUrl('/api/devices'), {
        method: 'DELETE', keepalive: true,
        headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: push })
      }).catch(() => {});
    }
    localStorage.removeItem(PUSH_KEY);
    localStorage.removeItem(TOKEN_KEY);
    location.href = '/';
  }
};

/** fetch wrapper: attaches the bearer token and turns API errors into thrown Errors. */
export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (auth.token) headers.Authorization = 'Bearer ' + auth.token;

  let body = opts.body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  /* A fetch only rejects when the request never reached the server at all, so
     this is always a connection problem — never a wrong password. The browser's
     own wording for it is "Failed to fetch", which tells the user nothing. */
  let res;
  try {
    res = await fetch(apiUrl('/api' + path), { ...opts, headers, body });
  } catch {
    const err = new Error(
      'Cannot reach the QHT server. Check that this device is on the same Wi-Fi as the server.'
    );
    err.offline = true;
    throw err;
  }

  // A 401 from the login call means "wrong credentials", not "session expired" —
  // bouncing to the login page there would wipe the error before it is shown.
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    auth.logout();
    throw new Error('Session expired');
  }

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    // 428 = onboarding step still outstanding; send them to whichever one it is
    if (res.status === 428) {
      const target = data?.code === 'PASSWORD_CHANGE_REQUIRED' ? '/set-password.html' : '/agreement.html';
      if (!onPage(target)) location.href = target;
    }
    const err = new Error((data && data.error) || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * The onboarding order for a newly registered person, in one place:
 *   accept the agreement  ->  replace the temporary password  ->  dashboard
 */
export function nextScreen(me) {
  if (me.needsAgreement) return '/agreement.html';
  if (me.mustChangePassword) return '/set-password.html';
  return homeFor(me.user.role);
}

/**
 * Whether the browser is already on a given page.
 *
 * Not a string comparison: Cloudflare Pages serves /set-password.html at
 * /set-password and redirects the long form to the short one. Comparing the
 * paths literally made every redirect fire again on arrival, so the app looped
 * between the same two screens and never settled.
 */
export const onPage = target => {
  const tidy = p => String(p).replace(/\.html$/, '').replace(/\/$/, '') || '/';
  return tidy(location.pathname) === tidy(target);
};

/**
 * Sends the browser elsewhere and stops the calling module.
 * Throwing here would surface as an uncaught page error even though the
 * redirect is working exactly as intended, so we just never settle.
 */
export const goTo = url => {
  location.href = url;
  return new Promise(() => {});
};

/** Loads the signed-in user and enforces role + onboarding routing. */
export async function requireUser(allowedRoles) {
  if (!auth.token) return goTo('/');

  const me = await api('/auth/me');

  const next = nextScreen(me);
  if (!onPage(next)) return goTo(next);

  if (allowedRoles && !allowedRoles.includes(me.user.role)) return goTo(homeFor(me.user.role));

  return me;
}

export const homeFor = role => (role === 'influencer' ? '/influencer.html' : '/dashboard.html');

/* --------------------------------- helpers --------------------------------- */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escapes text before it goes anywhere near innerHTML. */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const money = n => '₹' + Number(n || 0).toLocaleString('en-IN');

/* ------------------------------ phone rules ------------------------------ */
/* Mirrors server/lib/phone.js — the server re-checks, this is for instant feedback. */

export const DEFAULT_COUNTRY = '+91';

export const COUNTRY_CODES = [
  { code: '+91', label: 'India (+91)' },
  { code: '+971', label: 'UAE (+971)' },
  { code: '+44', label: 'UK (+44)' },
  { code: '+1', label: 'USA / Canada (+1)' },
  { code: '+65', label: 'Singapore (+65)' }
];

export function normalisePhone(input, countryCode = DEFAULT_COUNTRY) {
  let d = String(input ?? '').replace(/\D/g, '');
  const cc = String(countryCode || DEFAULT_COUNTRY).replace(/\D/g, '');
  // Strip a prefix only when doing so leaves exactly 10 digits, so a genuine
  // typo like 91234567890 is reported as 11 digits rather than silently trimmed.
  if (cc && d.length === cc.length + 10 && d.startsWith(cc)) d = d.slice(cc.length);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

export function validatePhone(input, countryCode = DEFAULT_COUNTRY) {
  const phone = normalisePhone(input, countryCode);
  if (!phone) return { ok: false, error: 'Phone number is required' };
  if (phone.length !== 10) {
    return { ok: false, error: `Must be exactly 10 digits — you have ${phone.length}` };
  }
  if (countryCode === '+91' && !/^[6-9]/.test(phone)) {
    return { ok: false, error: 'An Indian mobile number must start with 6, 7, 8 or 9' };
  }
  return { ok: true, phone };
}

/** Display form, e.g. "+91 98765 43210". */
export const formatPhone = (phone, countryCode = DEFAULT_COUNTRY) =>
  `${countryCode || DEFAULT_COUNTRY} ${String(phone || '').replace(/(\d{5})(\d{5})/, '$1 $2')}`.trim();

export const roleLabel = r =>
  ({ admin: 'QHT Admin', head_influencer: 'Head Influencer', influencer: 'Influencer' }[r] || r);

export const statusLabel = s =>
  ({ pending_agreement: 'Awaiting T&C', on_hold: 'On hold' }[s] || String(s || '').replace(/_/g, ' '));

/* The programme runs on Indian time, whatever the device is set to. */
const IST = 'Asia/Kolkata';

/* The server sends two kinds of value. A timestamp ("2026-09-11 06:08:59",
   from SQLite's datetime('now')) is UTC with no zone marker — read without the
   Z it was taken as local time, which showed 06:08 for a photo sent at 11:38.
   A bare date ("2026-09-11") is a calendar day, not an instant, and must not
   shift at all. */
const parseWhen = d => {
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { dt: new Date(s + 'T00:00:00Z'), zone: 'UTC', dayOnly: true };
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) {
    return { dt: new Date(s.replace(' ', 'T') + 'Z'), zone: IST };
  }
  return { dt: new Date(s), zone: IST };
};

export const fmtDate = d => {
  if (!d) return '—';
  const { dt, zone } = parseWhen(d);
  return isNaN(dt) ? d : dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: zone });
};

/** "11:38 am", on Indian time. Empty for a bare date — it has no time. */
export const fmtTime = d => {
  if (!d) return '';
  const { dt, dayOnly } = parseWhen(d);
  if (isNaN(dt) || dayOnly) return '';
  return dt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST });
};

export const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: IST });

export const badge = s => `<span class="badge ${esc(s)}">${esc(statusLabel(s))}</span>`;

/** Compliance bar; colour thresholds match the 80% agreement floor. */
export function complianceBar(pct) {
  const p = Number(pct) || 0;
  const cls = p >= 80 ? '' : p >= 50 ? 'warn' : 'bad';
  return `<div class="row" style="gap:.4rem">
      <div class="bar grow"><i class="${cls}" style="width:${Math.min(100, p)}%"></i></div>
      <span class="tiny mono">${p}%</span>
    </div>`;
}

/** Renders an authenticated image (media routes need the bearer header). */
export async function loadProtectedImage(imgEl, path) {
  try {
    const res = await fetch(apiUrl('/media/' + path), {
      headers: { Authorization: 'Bearer ' + auth.token }
    });
    if (!res.ok) throw new Error('load failed');
    imgEl.src = URL.createObjectURL(await res.blob());
    // a proof thumbnail opens full size (enablePhotoViewer) — by keyboard too
    if (imgEl.dataset.p) { imgEl.tabIndex = 0; imgEl.title = 'Open photo'; }
  } catch {
    imgEl.alt = 'Photo unavailable';
  }
}

/**
 * Saves a proof photo to the device, exactly as it was uploaded.
 *
 * The photo is private, so it cannot be a plain link — it is fetched with the
 * signed-in token. The thumbnail on screen already holds the whole file, so
 * that blob is reused: no second download, and no re-encoding, so the saved
 * file is byte for byte the one the influencer sent.
 *
 * @param {string} path      the photo path, as in data-p
 * @param {string} filename  what to call it on disk
 * @param {HTMLImageElement} [thumb]  the thumbnail already showing it
 */
export async function downloadProtectedImage(path, filename, thumb) {
  let url = thumb?.src?.startsWith("blob:") ? thumb.src : null;
  let temporary = null;

  if (!url) {
    const res = await fetch(apiUrl("/media/" + path), {
      headers: { Authorization: "Bearer " + auth.token }
    });
    if (!res.ok) throw new Error("Could not fetch that photo");
    temporary = URL.createObjectURL(await res.blob());
    url = temporary;
  }

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // only revoke what this call made; the thumbnail still needs its own
  if (temporary) setTimeout(() => URL.revokeObjectURL(temporary), 10_000);
}

/**
 * A proof photo at full size, over everything else. The thumbnail already
 * holds the whole photo (fetched by loadProtectedImage), so it is reused —
 * no second download. Closes on the ×, a tap outside the photo, or Esc.
 * @param {HTMLImageElement} thumb  an <img data-p="…"> thumbnail
 */
export function openPhoto(thumb) {
  const caption = thumb.dataset.cap || thumb.alt || '';
  const view = document.createElement('div');
  view.className = 'photo-view';
  view.setAttribute('role', 'dialog');
  view.setAttribute('aria-modal', 'true');
  view.setAttribute('aria-label', caption || 'Photo');
  view.innerHTML = `
    <button class="pv-close" type="button" aria-label="Close photo">×</button>
    <img class="pv-img" alt="${esc(thumb.alt || 'Photo')}">
    ${caption ? `<p class="pv-cap">${esc(caption)}</p>` : ''}`;

  const big = view.querySelector('.pv-img');
  if (thumb.src.startsWith('blob:')) big.src = thumb.src;
  else if (thumb.dataset.p) loadProtectedImage(big, thumb.dataset.p);   // still loading

  const onKey = e => { if (e.key === 'Escape') close(); };
  const close = () => {
    view.remove();
    document.removeEventListener('keydown', onKey);
    thumb.focus?.({ preventScroll: true });
  };
  view.onclick = e => { if (e.target !== big) close(); };
  document.addEventListener('keydown', onKey);
  document.body.append(view);
  view.querySelector('.pv-close').focus();
}

/**
 * Makes every proof thumbnail on the page (any <img data-p>) open full size,
 * including ones drawn later. Caught in the capture phase, so a photo inside
 * a card or row that opens something else opens the photo, not both.
 */
export function enablePhotoViewer() {
  document.addEventListener('click', e => {
    const img = e.target.closest?.('img[data-p]');
    if (!img || img.closest('.photo-view')) return;
    e.stopPropagation();
    e.preventDefault();
    openPhoto(img);
  }, true);
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('img[data-p]')) {
      e.preventDefault();
      openPhoto(e.target);
    }
  });
}

/* ---------------------------- password strength ---------------------------- */
/* Mirrors server/lib/password.js; the server re-checks on every change. */

export const PASSWORD_MIN = 8;

export const PASSWORD_RULES = [
  { key: 'len',     label: `At least ${PASSWORD_MIN} characters`,      test: v => v.length >= PASSWORD_MIN },
  { key: 'letter',  label: 'Contains a letter',                        test: v => /[A-Za-z]/.test(v) },
  { key: 'number',  label: 'Contains a number',                        test: v => /\d/.test(v) },
  { key: 'special', label: 'Contains a special character (! @ # $ …)', test: v => /[^A-Za-z0-9]/.test(v) }
];

export const passwordOk = v => PASSWORD_RULES.every(r => r.test(String(v ?? '')));

/** Renders the live rule checklist into a container and reports whether all pass. */
export function renderPasswordRules(container, value, extras = []) {
  const rules = [...PASSWORD_RULES, ...extras];
  const v = String(value ?? '');
  container.innerHTML = rules.map(r => {
    const ok = r.test(v);
    return `<li class="${ok ? 'ok' : ''}"><span class="tick">${ok ? '✓' : '○'}</span>${esc(r.label)}</li>`;
  }).join('');
  return rules.every(r => r.test(v));
}

/* ---------------------------- responsive tables ---------------------------- */
/**
 * Copies each table's column headings onto its cells as `data-label`, so the
 * stylesheet can turn rows into labelled cards on a phone.
 *
 * Done here rather than by hand in every template: the labels can never drift
 * out of step with the headers, and any table added later is covered for free.
 */
export function labelTableCells(root = document) {
  for (const table of root.querySelectorAll('table:not(.no-stack)')) {
    const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    if (!heads.length) continue;
    for (const row of table.querySelectorAll('tbody tr')) {
      [...row.children].forEach((cell, i) => {
        const label = heads[i];
        if (label) cell.setAttribute('data-label', label);
        else cell.removeAttribute('data-label');
      });
    }
  }
}

/**
 * Keeps `data-label` current as views re-render. Watches child changes only,
 * so writing the attributes cannot retrigger it.
 */
export function watchTables(container) {
  labelTableCells(container);
  new MutationObserver(() => labelTableCells(container))
    .observe(container, { childList: true, subtree: true });
}

/* ------------------------------ month picker ------------------------------ */
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Safari (desktop and iOS) has no month input — it silently becomes a text box. */
export const supportsMonthInput = (() => {
  const probe = document.createElement('input');
  probe.type = 'month';
  return probe.type === 'month';
})();

/**
 * Wires a YYYY-MM control inside `wrap`. Uses the native input where it exists,
 * and falls back to a month + year pair of selects on Safari.
 *
 * @param {HTMLElement} wrap     holds an <input type="month">
 * @param {string} value         current YYYY-MM
 * @param {(v: string) => void} onChange
 */
export function setupMonthControl(wrap, value, onChange) {
  const native = wrap.querySelector('input[type="month"], input[data-month]');
  if (!native) return;

  if (supportsMonthInput) {
    native.value = value;
    native.onchange = e => onChange(e.target.value || value);
    return;
  }

  const [y0, m0] = value.split('-').map(Number);
  const thisYear = new Date().getFullYear();
  const years = [];
  for (let y = thisYear + 1; y >= thisYear - 4; y--) years.push(y);
  if (!years.includes(y0)) years.push(y0);

  const box = document.createElement('div');
  box.className = 'month-fallback';
  box.innerHTML = `
    <select data-part="m" aria-label="Month">
      ${MONTH_NAMES.map((n, i) =>
        `<option value="${i + 1}" ${i + 1 === m0 ? 'selected' : ''}>${n}</option>`).join('')}
    </select>
    <select data-part="y" aria-label="Year">
      ${years.sort((a, b) => b - a).map(y =>
        `<option value="${y}" ${y === y0 ? 'selected' : ''}>${y}</option>`).join('')}
    </select>`;

  const emit = () => {
    const m = box.querySelector('[data-part="m"]').value.padStart(2, '0');
    const y = box.querySelector('[data-part="y"]').value;
    onChange(`${y}-${m}`);
  };
  box.querySelectorAll('select').forEach(s => s.onchange = emit);

  native.replaceWith(box);
}

/* --------------------------- show / hide password --------------------------- */
const EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;

const EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M10.6 6.1A9.7 9.7 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.3 3.9M6.3 7.5A17 17 0 0 0 2 12s3.6 6 10 6a9.5 9.5 0 0 0 4-.85"/>
  <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/></svg>`;

/**
 * Adds an eye button inside a password field. Wraps the input so the button can
 * sit over it; safe to call twice on the same field.
 */
export function enablePasswordToggle(input) {
  if (!input || input.dataset.pwToggle) return;
  input.dataset.pwToggle = '1';

  const wrap = document.createElement('div');
  wrap.className = 'pw-field';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pw-toggle';
  btn.innerHTML = EYE;
  btn.setAttribute('aria-label', 'Show password');
  btn.setAttribute('aria-pressed', 'false');
  btn.title = 'Show password';

  btn.onclick = () => {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    btn.innerHTML = reveal ? EYE_OFF : EYE;
    btn.setAttribute('aria-pressed', String(reveal));
    btn.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    btn.title = btn.getAttribute('aria-label');
    input.focus();
  };

  wrap.appendChild(btn);
}

export function toast(container, text, kind = 'ok') {
  if (!container) return;
  container.innerHTML = `<div class="msg ${kind}">${esc(text)}</div>`;
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (kind === 'ok') setTimeout(() => { container.innerHTML = ''; }, 4000);
}

/**
 * The dark bar above the dashboard on small screens.
 *
 * Only the menu button and the brand live here: the signed-in user and the
 * sign-out control belong to the sidebar drawer, and repeating them left the
 * cramped mobile bar showing the same name twice.
 */
export function mountTopbar(el) {
  el.innerHTML = `
    <button class="nav-toggle" id="navToggle" aria-label="Open menu" aria-expanded="false"
            aria-controls="tabs">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
    </button>
    <div class="brand"><span class="qht-mark" aria-hidden="true"></span> QHT Influencer Manager</div>
    ${THEME_BUTTON()}`;
}
