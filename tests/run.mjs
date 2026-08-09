#!/usr/bin/env node
// Пуска всички набори и връща ненулев код при провал, за да върши работа в CI.
//   node tests/run.mjs            всички
//   node tests/run.mjs regression само този набор
import { getChromium, summary, suite, check } from './lib.mjs';
import { simulate, BASELINE_V01, DRIFT_LIMIT, fmtTime } from '../tools/balance.js';

const SUITES = {
  regression: () => import('./regression.mjs'),
  features:   () => import('./features.mjs'),
  pwa:        () => import('./pwa.mjs')
};

function balanceCheck() {
  suite('баланс');
  const { first } = simulate();
  for (const [name, base] of Object.entries(BASELINE_V01)) {
    const got = first[name];
    if (got === undefined) { check(`${name} се достига`, false, 'постът не беше купен'); continue; }
    const drift = Math.abs(got - base) / base;
    check(`${name}: ${fmtTime(got)}`, drift <= DRIFT_LIMIT,
      `отклонение ${(drift * 100).toFixed(1)}% спрямо 0.1 (праг ${DRIFT_LIMIT * 100}%)`);
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
