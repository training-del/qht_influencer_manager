/**
 * Cuts the supplied QHT logo into the pieces the app needs.
 *
 * The artwork itself is never redrawn — this only trims the white page around
 * it and turns the black ink into an alpha channel, so the very same shapes can
 * be painted white on the dark bars and teal on the light ones (CSS masks the
 * PNG and fills it with a colour).
 *
 *   brand/qht-logo-source.png  ->  public/icons/qht-mark.png   (dandelion only)
 *                                  public/icons/qht-logo.png   (mark + wordmark)
 *                                  public/icons/qht-word.png   (wordmark only)
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'brand/qht-logo-source.png';
const dataUri = 'data:image/png;base64,' + readFileSync(SRC).toString('base64');

const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
await p.setContent('<body></body>');

const parts = await p.evaluate(async (src) => {
  const img = new Image();
  img.src = src;
  await img.decode();

  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height);
  const d = px.data;

  /* Ink -> alpha. The source is black on white, so how dark a pixel is *is* its
     coverage; keeping it as alpha preserves the anti-aliased edges exactly. */
  for (let i = 0; i < d.length; i += 4) {
    const lum = Math.min(d[i], d[i + 1], d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = 0;
    d[i + 3] = 255 - lum;
  }
  g.putImageData(px, 0, 0);

  const CUT = 20;                                  // ignore near-white noise
  const alphaAt = (x, y) => d[(y * c.width + x) * 4 + 3];
  const rowHasInk = y => { for (let x = 0; x < c.width; x++) if (alphaAt(x, y) > CUT) return true; return false; };
  const colHasInk = x => { for (let y = 0; y < c.height; y++) if (alphaAt(x, y) > CUT) return true; return false; };

  let top = 0, bottom = c.height - 1, left = 0, right = c.width - 1;
  while (top < bottom && !rowHasInk(top)) top++;
  while (bottom > top && !rowHasInk(bottom)) bottom--;
  while (left < right && !colHasInk(left)) left++;
  while (right > left && !colHasInk(right)) right--;

  /* The widest band of blank rows inside the logo is the gap between the
     dandelion and the QHT wordmark — that is where the two parts split. */
  let best = { start: -1, len: 0 };
  let run = -1;
  for (let y = top; y <= bottom; y++) {
    if (!rowHasInk(y)) { if (run < 0) run = y; }
    else if (run >= 0) { if (y - run > best.len) best = { start: run, len: y - run }; run = -1; }
  }
  const split = best.len > 0 ? best.start + Math.round(best.len / 2) : bottom;

  /** Crops a region, tight to its own ink, with a little room for round caps. */
  const cut = (y0, y1) => {
    let l = left, r = right, t = y0, bm = y1;
    while (t < bm && !rowHasInk(t)) t++;
    while (bm > t && !rowHasInk(bm)) bm--;
    const hasInkInBand = x => { for (let y = t; y <= bm; y++) if (alphaAt(x, y) > CUT) return true; return false; };
    while (l < r && !hasInkInBand(l)) l++;
    while (r > l && !hasInkInBand(r)) r--;

    const w = r - l + 1, h = bm - t + 1;
    const pad = Math.round(Math.max(w, h) * 0.02);
    const out = document.createElement('canvas');
    out.width = w + pad * 2; out.height = h + pad * 2;
    out.getContext('2d').drawImage(c, l, t, w, h, pad, pad, w, h);
    return { url: out.toDataURL('image/png'), w: out.width, h: out.height };
  };

  return { mark: cut(top, split), word: cut(split, bottom), full: cut(top, bottom) };
}, dataUri);

await b.close();

for (const [name, part] of Object.entries({
  'qht-mark.png': parts.mark,
  'qht-word.png': parts.word,
  'qht-logo.png': parts.full
})) {
  writeFileSync('public/icons/' + name, Buffer.from(part.url.split(',')[1], 'base64'));
  console.log(`  ${name.padEnd(14)} ${part.w}x${part.h}`);
}
