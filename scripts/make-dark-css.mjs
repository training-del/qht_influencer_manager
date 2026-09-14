/**
 * Builds public/css/dark.css — the dark theme — from the light stylesheets.
 *
 *   node scripts/make-dark-css.mjs        (npm run dark-css; deploy and the APK build run it)
 *
 * The light CSS has a few hundred hand-picked colours, most of them written out
 * rather than taken from variables. A hand-written dark copy of each would be
 * long and would silently fall behind every later change, so this reads the
 * light rules and writes a dark twin of every declaration that carries a
 * colour, scoped to html[data-theme="dark"]:
 *
 *   backgrounds   light fills become dark surfaces of the same tint;
 *                 strong fills (teal buttons, the red Reject) are kept
 *   text          dark text becomes light, keeping its hue
 *   borders       light lines become subtle dark ones
 *   shadows       light glows fade out; dark shadows stay
 *
 * The shared variables (--bg, --card, --ink …) get a hand-picked palette, and a
 * short list of hand tweaks at the end covers what a formula cannot judge.
 * Never edit dark.css itself — change this file or the light CSS and rerun.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SCOPE = 'html[data-theme="dark"]';
const SOURCES = [
  'public/css/app.css',
  'public/css/login.css',
  'public/agreement.html',
  'public/set-password.html',
  'public/offline.html'
];

/* ------------------------------ colour maths ------------------------------ */
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

function parseColor(str) {
  const s = str.trim().toLowerCase();
  if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    };
  }
  m = s.match(/^rgba?\(([^)]*)\)$/);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = p => (p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p));
    const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    return { r: num(parts[0]), g: num(parts[1]), b: num(parts[2]), a };
  }
  return null;
}

function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const hue = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: Math.round(hue(p, q, h + 1 / 3) * 255), g: Math.round(hue(p, q, h) * 255), b: Math.round(hue(p, q, h - 1 / 3) * 255) };
}

const hex2 = v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
const format = ({ r, g, b, a }) =>
  a >= 1 ? `#${hex2(r)}${hex2(g)}${hex2(b)}` : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${+a.toFixed(3)})`;

/** One colour, for the part it plays. */
function darken(c, role) {
  let { h, s, l } = rgbToHsl(c);
  /* A colourless white or grey has no hue to keep. Left grey it turned into a
     neutral near-black beside the blue-slate cards, so it takes their tint. */
  const slate = () => { if (s < 0.12) { h = 0.6; s = 0.3; } };
  switch (role) {
    case 'surface':
      if (l >= 0.55) { slate(); l = 0.11 + (1 - l) * 0.6; s = Math.min(s, 0.42); }   // light fill → dark surface
      break;                                                                          // strong fills stay
    case 'text':
      if (l <= 0.6) { l = 0.93 - l * 0.35; s *= 0.75; }                              // dark ink → light ink
      break;
    case 'border':
      if (l >= 0.5) { slate(); l = 0.2 + (1 - l) * 0.5; s = Math.min(s, 0.35); }
      break;
    case 'shadow':
      if (l >= 0.5) { l = 0.06; s = 0; }                                   // a light glow would shine
      break;
    default:
      return c;                                                             // 'keep'
  }
  return { ...hslToRgb(h, s, l), a: c.a };
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\bwhite\b|\bblack\b/g;

function roleForProperty(prop) {
  if (/^(color|fill|stroke|caret-color|-webkit-text-fill-color|text-decoration-color|-webkit-text-stroke-color)$/.test(prop)) return 'text';
  if (/^outline/.test(prop)) return 'keep';                                  // focus rings must stay visible
  if (/^(border|column-rule)/.test(prop)) return 'border';
  if (/shadow/.test(prop)) return 'shadow';
  return 'surface';
}

/* A variable plays a role its name gives away; accents keep their colour. */
function roleForVariable(name) {
  if (/accent|dot|brand/.test(name)) return 'keep';
  if (/ink|text|fg|label|name/.test(name)) return 'text';
  if (/line|edge|border|rule|ring/.test(name)) return 'border';
  return 'surface';
}

/* ------------------------------ tiny CSS parser ------------------------------ */
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

function parseBlocks(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    let prelude = css.slice(i, open);
    if (prelude.includes(';')) prelude = prelude.slice(prelude.lastIndexOf(';') + 1);   // @import …;
    prelude = prelude.trim();
    let depth = 1, j = open + 1;
    while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    const body = css.slice(open + 1, j - 1);
    if (prelude.startsWith('@')) {
      if (/^@(media|supports)/.test(prelude)) out.push({ at: prelude, rules: parseBlocks(body) });
      // @keyframes, @font-face: left as they are
    } else if (prelude) {
      out.push({ selector: prelude, body });
    }
    i = j;
  }
  return out;
}

/** Splits at a separator that is not inside parentheses or quotes. */
function splitTop(str, sep) {
  const parts = [];
  let depth = 0, quote = null, cur = '';
  for (const ch of str) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function scopeSelector(sel) {
  return splitTop(sel, ',').map(s => {
    s = s.trim();
    if (s.startsWith(':root')) return SCOPE + s.slice(5);
    if (/^html\b/.test(s)) return s.startsWith('html[data-theme') ? null : SCOPE + s.slice(4);
    return `${SCOPE} ${s}`;
  }).filter(Boolean).join(',\n');
}

/** The dark twin of a rule's colour declarations, or '' when it has none. */
function darkRule({ selector, body }) {
  if (/^:root\b/.test(selector.trim())) return '';           // the variables get the palette below
  if (selector.includes('data-theme')) return '';            // already theme-aware
  const decls = [];
  for (const raw of splitTop(body, ';')) {
    const colon = raw.indexOf(':');
    if (colon < 0) continue;
    const prop = raw.slice(0, colon).trim().toLowerCase();
    const value = raw.slice(colon + 1).trim();
    if (!prop || !value || !COLOR_RE.test(value)) { COLOR_RE.lastIndex = 0; continue; }
    COLOR_RE.lastIndex = 0;
    const role = prop.startsWith('--') ? roleForVariable(prop) : roleForProperty(prop);
    if (role === 'keep') continue;
    const next = value.replace(COLOR_RE, m => {
      const c = parseColor(m);
      return c ? format(darken(c, role)) : m;
    });
    if (next !== value) decls.push(`  ${prop}: ${next};`);
  }
  if (!decls.length) return '';
  const scoped = scopeSelector(selector);
  return scoped ? `${scoped} {\n${decls.join('\n')}\n}\n` : '';
}

function emit(blocks) {
  let css = '';
  for (const b of blocks) {
    if (b.at) {
      const inner = emit(b.rules);
      if (inner.trim()) css += `${b.at} {\n${inner.replace(/^/gm, '  ').trimEnd()}\n}\n`;
    } else {
      css += darkRule(b);
    }
  }
  return css;
}

/* ------------------------------ the palette ------------------------------ */
const PALETTE = `${SCOPE} {
  color-scheme: dark;
  --teal: #0d9488;
  --teal-dark: #5eead4;
  --teal-soft: #123f3b;
  --ink: #e5edf5;
  --body: #cbd5e1;
  --muted: #94a3b8;
  --line: #2a3648;
  --bg: #0b1220;
  --card: #131c2c;
  --green: #34d399;
  --green-soft: #0f3b2e;
  --red: #dc2626;
  --red-soft: #3f1d1f;
  --amber: #fbbf24;
  --amber-soft: #3d2e10;
  --blue: #60a5fa;
  --blue-soft: #16264a;
  --shadow: 0 1px 3px rgba(0, 0, 0, .55), 0 1px 2px rgba(0, 0, 0, .35);
  --side-pill-ink: #ffffff;
}
`;

/* What a formula cannot judge. Kept short on purpose. */
const TWEAKS = `
/* ---- hand tweaks ---- */
${SCOPE} body { background: var(--bg); color: var(--body); }
${SCOPE} .topbar .brand .qht-mark { color: #e5edf5; }
${SCOPE} input, ${SCOPE} select, ${SCOPE} textarea { background-color: #0f1726; color: var(--ink); border-color: #334155; }
${SCOPE} input::placeholder, ${SCOPE} textarea::placeholder { color: #7b8aa0; }
${SCOPE} .theme-btn { background: rgba(255, 255, 255, .08); border-color: #3d5a55; color: #e5edf5; }
${SCOPE} .theme-btn:hover { background: rgba(255, 255, 255, .16); }

/* the other buttons in the top bar match the switch */
${SCOPE} .bar-out, ${SCOPE} .nav-toggle { background: rgba(255, 255, 255, .08); border-color: #3d5a55; color: #e5edf5; }
${SCOPE} .nav-toggle:hover { background: rgba(255, 255, 255, .16); }
${SCOPE} .bar-out:hover { background: rgba(248, 113, 113, .16); color: #fca5a5; }

/* White text needs a deeper teal behind it than --teal (3.7:1). The light
   theme hovers to --teal-dark, which is a LIGHT teal here — white on it
   would vanish — so the hover goes darker instead. */
${SCOPE} button.btn:not(.ghost):not(.danger) { background: #0f766e; }
${SCOPE} button.btn:not(.ghost):not(.danger):hover { background: #115e59; }
${SCOPE} button.btn.danger:hover { background: #b91c1c; }
${SCOPE} .seg button.active { background: #0f766e; color: #ffffff; box-shadow: 0 1px 4px rgba(0, 0, 0, .5); }
${SCOPE} .sidenav button.active { background: #0f766e; color: #ffffff; }

${SCOPE} .topbar .who .role { color: #dcefeb; }
${SCOPE} .review-table thead .col-approve { color: #6ee7b7; }
${SCOPE} .review-table thead .col-reject { color: #fca5a5; }
`;

/* ------------------------------ build ------------------------------ */
let body = '';
for (const file of SOURCES) {
  let css = readFileSync(file, 'utf8');
  if (file.endsWith('.html')) css = [...css.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
  const out = emit(parseBlocks(stripComments(css)));
  if (out.trim()) body += `\n/* ============ from ${file} ============ */\n${out}`;
}

const header = `/* GENERATED by scripts/make-dark-css.mjs — do not edit by hand.
   The dark theme: every colour of the light CSS, re-mapped, under ${SCOPE}. */\n`;
writeFileSync('public/css/dark.css', header + PALETTE + body + TWEAKS);

const rules = (body.match(/\{\n/g) || []).length;
console.log(`public/css/dark.css written — ${rules} dark rules, ${(Buffer.byteLength(header + PALETTE + body + TWEAKS) / 1024).toFixed(1)} KB`);
