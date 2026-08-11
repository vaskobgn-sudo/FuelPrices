#!/usr/bin/env node
// Пуска всички набори и връща ненулев код при провал, за да върши работа в CI.
//   node tests/run.mjs            всички
//   node tests/run.mjs regression само този набор
import { getChromium, summary, suite, check } from './lib.mjs';
import { checkTargets, fmtTime } from '../tools/balance.js';

const SUITES = {
  regression: () => import('./regression.mjs'),
  features:   () => import('./features.mjs'),
  pwa:        () => import('./pwa.mjs')
};

// Балансът вече не се сверява с 0.1 — в 0.3 той е сменен нарочно. Проверява се
// попадане в целевите прозорци, тоест че съдържанието НЕ се изяжда за вечер.
function balanceCheck() {
  suite('баланс');
  for (const r of checkTargets()) {
    const got = r.text !== undefined ? r.text : fmtTime(r.got);
    const window = r.text !== undefined ? '' :
      (r.max === undefined ? `поне ${fmtTime(r.min)}`
                           : `прозорец ${fmtTime(r.min)} – ${fmtTime(r.max)}`);
    check(`${r.name}: ${got}`, r.ok, window);
  }
}

const wanted = process.argv.slice(2).filter(a => !a.startsWith('-'));
const names = wanted.length ? wanted : Object.keys(SUITES);

const chromium = await getChromium();
const browser = await chromium.launch();
try {
  balanceCheck();
  for (const name of names) {
    const loader = SUITES[name];
    if (!loader) { console.log(`\n(пропуснат непознат набор: ${name})`); continue; }
    let mod;
    try { mod = await loader(); }
    catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND') { console.log(`\n(набор ${name} още не съществува)`); continue; }
      throw e;
    }
    console.log(`\n──── ${name} ────`);
    // Един паднал елемент не бива да убива останалите набори — в CI искаме
    // пълния отчет, а не първата грешка.
    try { await mod.default(browser); }
    catch (e) { check(`наборът ${name} приключи без изключение`, false, e.message.split('\n')[0]); }
  }
} finally {
  await browser.close();
}
process.exit(summary() === 0 ? 0 : 1);
