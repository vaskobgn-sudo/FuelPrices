#!/usr/bin/env node
// Рендира PNG иконите за манифеста от SVG-тата в mehanata.html.
//
// Манифестът иска PNG — Safari не приема надеждно SVG икони, а самата
// „Механа“ нарочно няма canvas (чупи се във WebView). Затова растеризацията
// се прави тук, при билда, през Chromium, който така или иначе върви за
// тестовете. Резултатът се комитва, за да не иска CI браузър.
//
//   node tools/make-icons.js
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChromium } from '../tests/lib.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(REPO, 'site');
const BG = '#14100c';
const AMBER = '#e8a33d';

const TARGETS = [
  { file: 'icon-192.png', size: 192, pad: 0.10, round: true },
  { file: 'icon-512.png', size: 512, pad: 0.10, round: true },
  // maskable: системата може да отреже до 20% от всяка страна, затова
  // рисунката стои в централните 60% и фонът пълни целия квадрат
  { file: 'icon-512-maskable.png', size: 512, pad: 0.22, round: false },
  { file: 'apple-touch-icon.png', size: 180, pad: 0.10, round: false }
];

const chromium = await getChromium();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('file://' + resolve(REPO, 'mehanata.html'));
await page.waitForTimeout(400);

const src = await page.evaluate(() => window.MEHANA_ASSETS?.mehana || null);
if (!src) { await browser.close(); throw new Error('MEHANA_ASSETS.mehana липсва'); }

mkdirSync(OUT, { recursive: true });

for (const t of TARGETS) {
  const inner = Math.round(t.size * (1 - 2 * t.pad));
  const html = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0}
  body{width:${t.size}px;height:${t.size}px;display:grid;place-items:center;
       background:${BG};${t.round ? `border-radius:${Math.round(t.size * 0.22)}px;` : ''}
       box-shadow:inset 0 0 0 ${Math.max(2, Math.round(t.size / 64))}px ${AMBER}33;}
  img{width:${inner}px;height:${inner}px;display:block;
      filter:drop-shadow(0 ${Math.round(t.size / 64)}px ${Math.round(t.size / 40)}px rgba(0,0,0,.55));}
</style><img src="${src}">`;
  const p = await browser.newPage();
  await p.setViewportSize({ width: t.size, height: t.size });
  await p.setContent(html);
  await p.waitForTimeout(150);
  const buf = await p.screenshot({ omitBackground: !t.round ? false : true });
  writeFileSync(resolve(OUT, t.file), buf);
  console.log(`  ${t.file.padEnd(24)} ${t.size}×${t.size}  ${(buf.length / 1024).toFixed(1)} KB`);
  await p.close();
}

await browser.close();
console.log('Готово: ' + OUT);
