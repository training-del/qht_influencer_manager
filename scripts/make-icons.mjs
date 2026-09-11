/* Renders the QHT mark to real PNG icons for the manifest, using the browser
   we already have — no image library needed. The mark is masked from the
   supplied artwork, so the icons show exactly the logo, painted white. */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'public/icons';
mkdirSync(OUT, { recursive: true });

const MARK = 'data:image/png;base64,' +
  readFileSync(join(OUT, 'qht-mark.png')).toString('base64');

/** @param {boolean} maskable  pad the mark so Android's mask cannot clip it */
const html = (size, maskable) => {
  const pad = maskable ? 0.20 : 0.10;          // safe area for maskable icons
  const inner = Math.round(size * (1 - pad * 2));
  const radius = maskable ? '50%' : `${Math.round(size * 0.22)}px`;
  const tile = maskable ? size : inner;
  const art = Math.round(tile * 0.66);
  return `<!doctype html><meta charset="utf-8">
  <style>
    html,body{margin:0;width:${size}px;height:${size}px}
    body{display:grid;place-items:center;background:${maskable ? '#0d9488' : 'transparent'}}
    .m{
      width:${tile}px;height:${tile}px;
      border-radius:${radius};
      background:linear-gradient(150deg,#14b8a6,#0b5f57);
      display:grid;place-items:center;
    }
    .mark{
      width:${art}px;height:${Math.round(art * 0.884)}px;background:#fff;
      -webkit-mask:url('${MARK}') center/contain no-repeat;
      mask:url('${MARK}') center/contain no-repeat;
    }
  </style>
  <div class="m"><div class="mark"></div></div>`;
};

const b = await chromium.launch();
const made = [];

for (const [size, maskable, name] of [
  [192, false, 'icon-192.png'],
  [512, false, 'icon-512.png'],
  [512, true, 'icon-maskable-512.png'],
  [180, false, 'apple-touch-icon.png'],
  [32, false, 'favicon-32.png']
]) {
  const ctx = await b.newContext({ viewport: { width: size, height: size } });
  const p = await ctx.newPage();
  await p.setContent(html(size, maskable));
  await p.waitForTimeout(120);                  // let the mask image decode
  await p.screenshot({ path: join(OUT, name), omitBackground: !maskable });
  made.push(`${name} (${size}px${maskable ? ', maskable' : ''})`);
  await ctx.close();
}

await b.close();
made.forEach(m => console.log('  ' + m));
