/* Replaces Capacitor's default launcher icons with the QHT mark, at every density. */
import { chromium } from 'playwright';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RES = 'android/app/src/main/res';
const MARK = 'data:image/png;base64,' +
  readFileSync('public/icons/qht-mark.png').toString('base64');

/** Android launcher densities: folder -> icon size in px */
const DENSITIES = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192
};

/**
 * kind = 'square'   -> ic_launcher.png       (rounded square)
 *        'round'    -> ic_launcher_round.png (circle)
 *        'fore'     -> ic_launcher_foreground.png (adaptive: mark on transparent,
 *                      inset to the 66% safe zone Android crops to)
 */
const html = (size, kind) => {
  const inset = kind === 'fore' ? 0.28 : 0;
  const inner = Math.round(size * (1 - inset * 2));
  const radius = kind === 'round' ? '50%' : `${Math.round(inner * 0.22)}px`;
  const art = Math.round(inner * 0.66);
  return `<!doctype html><meta charset="utf-8">
    <style>
      html,body{margin:0;width:${size}px;height:${size}px;background:transparent}
      body{display:grid;place-items:center}
      .m{width:${inner}px;height:${inner}px;border-radius:${radius};
         background:linear-gradient(150deg,#14b8a6,#0b5f57);
         display:grid;place-items:center}
      .mark{width:${art}px;height:${Math.round(art * 0.884)}px;background:#fff;
         -webkit-mask:url('${MARK}') center/contain no-repeat;
         mask:url('${MARK}') center/contain no-repeat}
    </style><div class="m"><div class="mark"></div></div>`;
};

const b = await chromium.launch();
let n = 0;

for (const [folder, size] of Object.entries(DENSITIES)) {
  const dir = join(RES, folder);
  if (!existsSync(dir)) { console.log('  skipped (missing): ' + folder); continue; }

  for (const [kind, file] of [
    ['square', 'ic_launcher.png'],
    ['round', 'ic_launcher_round.png'],
    ['fore', 'ic_launcher_foreground.png']
  ]) {
    const ctx = await b.newContext({ viewport: { width: size, height: size } });
    const p = await ctx.newPage();
    await p.setContent(html(size, kind));
    await p.waitForTimeout(120);                // let the mask image decode
    writeFileSync(join(dir, file), await p.screenshot({ omitBackground: true }));
    await ctx.close();
    n++;
  }
  console.log(`  ${folder.padEnd(16)} ${size}px  ×3`);
}

await b.close();
console.log(`\n${n} launcher icons written`);
