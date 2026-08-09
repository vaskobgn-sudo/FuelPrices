// Обща основа за тестовете на „Механата“.
// Пуска се с: node tests/run.mjs
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..');
// MEHANATA_URL позволява да пуснем същия набор срещу друг билд
// (стара версия, или site/index.html през http) без да пипаме тестовете.
export const GAME_URL = process.env.MEHANATA_URL || ('file://' + resolve(REPO, 'mehanata.html'));

// Playwright може да е локално инсталиран или глобален — пробваме и двете.
export async function getChromium() {
  const tries = ['playwright', '/opt/node22/lib/node_modules/playwright/index.js'];
  for (const spec of tries) {
    try {
      const mod = await import(spec);
      return (mod.chromium || mod.default?.chromium);
    } catch { /* следващият */ }
  }
  throw new Error('Playwright не е намерен. npm i -D playwright');
}

/* ---------- отчитане ---------- */
const results = [];
let currentSuite = '(без набор)';
export function suite(name) { currentSuite = name; }

export function check(name, pass, detail) {
  results.push({ suite: currentSuite, name, pass: !!pass, detail: detail ?? '' });
  const mark = pass ? '  ok  ' : ' FAIL ';
  console.log(mark + name + (detail ? '   ' + detail : ''));
}
export function eq(name, got, want) {
  check(name, Object.is(got, want), `получено ${JSON.stringify(got)}, очаквано ${JSON.stringify(want)}`);
}
export function close(name, got, want, tolerance = 0.01) {
  const denom = Math.abs(want) > 1e-12 ? Math.abs(want) : 1;
  const rel = Math.abs(got - want) / denom;
  check(name, rel <= tolerance,
    `получено ${fmtNum(got)}, очаквано ${fmtNum(want)} (отклонение ${(rel * 100).toFixed(2)}%)`);
}
function fmtNum(n) { return typeof n === 'number' ? (Number.isInteger(n) ? n : n.toFixed(4)) : String(n); }
export function summary() {
  const failed = results.filter(r => !r.pass);
  console.log('\n' + '='.repeat(64));
  console.log(`Общо ${results.length} проверки, ${results.length - failed.length} минали, ${failed.length} паднали`);
  if (failed.length) {
    console.log('\nПаднали:');
    for (const f of failed) console.log(`  [${f.suite}] ${f.name} — ${f.detail}`);
  }
  return failed.length;
}

/* ---------- състояние на играта ---------- */
export const BASE_SAVE = {
  version: 1, money: 0, gens: {}, seen: {}, upgrades: {}, stars: 0, prestiges: 0,
  earnedRun: 0, earnedTotal: 0, taps: 0, playtime: 0, peakMoney: 0, bestRate: 0,
  bestStars: 0, achv: {}, eventsCaught: 0, muted: true, boostUntil: 0, savedAt: 0
};

/**
 * Отваря играта в чист контекст с подадено начално състояние.
 * Записът се инжектира през init script, защото reload() пуска pagehide и
 * играта записва отгоре преди новият документ да е прочел.
 */
export async function withGame(browser, state, fn, opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 360, height: 640 },
    deviceScaleFactor: opts.dpr || 2,
    isMobile: true, hasTouch: true
  });
  if (state) {
    const full = { ...BASE_SAVE, ...state };
    if (!full.savedAt) full.savedAt = Date.now();
    await ctx.addInitScript(s => localStorage.setItem('mehanata_save', s), JSON.stringify(full));
  }
  if (opts.initScript) await ctx.addInitScript(opts.initScript);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => {
    // vibrate иска реален жест; в харнеса това е шум, не дефект
    if (m.type() === 'error' && !/vibrate|execCommand/i.test(m.text())) errors.push(m.text());
  });
  await page.goto(opts.url || GAME_URL);
  await page.waitForTimeout(opts.settle ?? 500);
  try {
    return await fn(page, ctx, errors);
  } finally {
    if (errors.length) check('без грешки в конзолата', false, errors.join(' | '));
    await ctx.close();
  }
}

/** Тап през събития — Playwright отказва да тапне вечно анимиран елемент. */
export const tap = (page, sel) => page.evaluate(s => {
  const e = document.querySelector(s);
  if (!e) throw new Error('няма елемент ' + s);
  e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  e.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}, sel);

export const text = (page, sel) => page.evaluate(s => {
  const e = document.querySelector(s); return e ? e.innerText.trim() : null;
}, sel);

/**
 * Принуждава игровия запис. Без това `readSave` често връща ИНЖЕКТИРАНОТО
 * състояние, а не текущото: автозаписът е на 5 секунди и рядко се вмества в
 * прозореца на един тест, а тапването нарочно не записва при всеки удар.
 * pagehide е закачен за onHide() в играта, тоест води право до save().
 */
export const forceSave = page => page.evaluate(() =>
  window.dispatchEvent(new Event('pagehide')));

/** Числото от елемент като „4.21 млн. лв.“ не става за сметки — четем от записа. */
export const readSave = async (page, { fresh = true } = {}) => {
  if (fresh) { await forceSave(page); await page.waitForTimeout(30); }
  return page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('mehanata_save')); } catch { return null; }
  });
};

export const goTab = (page, scr) => page.evaluate(s => {
  document.querySelector('nav button[data-scr="' + s + '"]')
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, scr);

/** Истински touch drag, за да се провери че списъкът наистина скролва с пръст. */
export async function dragScroll(page, ctx, sel) {
  const box = await page.locator(sel).boundingBox();
  const cdp = await ctx.newCDPSession(page);
  const cx = box.x + box.width / 2;
  const y1 = box.y + box.height * 0.85, y2 = box.y + box.height * 0.15;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: y1 }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: cx, y: y1 + (y2 - y1) * i / 10 }]
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(450);
  return page.evaluate(s => {
    const e = document.querySelector(s);
    return { top: Math.round(e.scrollTop), max: Math.round(e.scrollHeight - e.clientHeight) };
  }, sel);
}
