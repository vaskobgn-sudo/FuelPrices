#!/usr/bin/env node
// Симулация на кривата на прогресията на „Механата“.
//
// Играч, който купува винаги най-бързо изплащащото се (пост или ъпгрейд),
// без престиж и без тапане. Дава кога се появява първата бройка от всеки пост.
// Пуска се с: node tools/balance.js [--json]
//
// Числата тук ТРЯБВА да съвпадат с GENS в mehanata.html. Ако ги промениш там,
// промени ги и тук, иначе тестът за регресия на баланса лъже.

const GENS = [
  ['Ракия',           15,          0.1],
  ['Шопска салата',   100,         1],
  ['Мезе',            1100,        8],
  ['Скара',           12000,       47],
  ['Гайдар',          130000,      260],
  ['Изба',            1400000,     1400],
  ['Тераса',          20000000,    7800],
  ['Хоро',            330000000,   44000],
  ['Автобус',         5100000000,  260000],
  ['Верига механи',   75000000000, 1600000]
];
const GROWTH = 1.15;
const UPG_STEPS = [10, 25, 50, 100];

// Записана база от Алфа 0.1, в секунди. Регресия = отклонение над прага.
export const BASELINE_V01 = {
  'Шопска салата': 100.0, 'Мезе': 747.8, 'Ракия': 749.2, 'Скара': 1316.9,
  'Гайдар': 2155.8, 'Изба': 3536.3, 'Тераса': 6693.4, 'Хоро': 14488.4,
  'Автобус': 33177.9, 'Верига механи': 84067.0
};
export const DRIFT_LIMIT = 0.15;   // над 15% отклонение = регресия в баланса

export function simulate() {
  const n = GENS.length;
  const own = new Array(n).fill(0);
  const upg = new Array(n).fill(0);
  let money = 0, t = 0, guard = 0;
  const first = {};

  const genCost = i => GENS[i][1] * Math.pow(GROWTH, own[i]);
  const upgCost = (i, k) => GENS[i][1] * 10 * Math.pow(5, k);
  const rate = () => own.reduce((s, c, i) => s + c * GENS[i][2] * Math.pow(2, upg[i]), 0);

  while (own[n - 1] < 1 && guard++ < 2_000_000) {
    let best = -1, bestPay = Infinity, kind = null, bestK = 0;
    for (let i = 0; i < n; i++) {
      const pay = genCost(i) / (GENS[i][2] * Math.pow(2, upg[i]));
      if (pay < bestPay) { bestPay = pay; best = i; kind = 'gen'; }
    }
    for (let i = 0; i < n; i++) {
      if (upg[i] < 4 && own[i] >= UPG_STEPS[upg[i]]) {
        const added = own[i] * GENS[i][2] * Math.pow(2, upg[i]);   // удвояването добавя толкова
        const pay = upgCost(i, upg[i]) / added;
        if (pay < bestPay) { bestPay = pay; best = i; kind = 'upg'; bestK = upg[i]; }
      }
    }
    const cost = kind === 'gen' ? genCost(best) : upgCost(best, bestK);
    const r = rate();
    if (money < cost) {
      const dt = r > 0 ? (cost - money) / r : (cost - money);
      t += dt; money += r * dt;
    }
    money -= cost;
    if (kind === 'gen') {
      if (own[best] === 0) first[GENS[best][0]] = t;
      own[best]++;
    } else upg[best]++;
  }
  return { first, total: t, finalRate: rate() };
}

export function fmtTime(s) {
  s = Math.round(s);
  if (s < 3600) return (s / 60).toFixed(1) + ' мин';
  if (s < 86400) return (s / 3600).toFixed(1) + ' ч';
  return (s / 86400).toFixed(1) + ' дни';
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const { first, total, finalRate } = simulate();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ first, total, finalRate }, null, 2));
  } else {
    console.log('Първа бройка от всеки пост (без престиж, без тапане):\n');
    for (const [name, t] of Object.entries(first)) {
      const base = BASELINE_V01[name];
      const drift = base ? ((t - base) / base * 100) : null;
      const tag = drift === null ? '' :
        (Math.abs(drift) < 1 ? '  =' : `  ${drift > 0 ? '+' : ''}${drift.toFixed(0)}% спрямо 0.1`);
      console.log('  ' + name.padEnd(16) + fmtTime(t).padStart(9) + tag);
    }
    console.log('\nОбщо до 10-ия пост: ' + fmtTime(total));
    console.log('Приход тогава: ' + Math.round(finalRate).toLocaleString('bg-BG') + ' лв/сек');
  }
}
