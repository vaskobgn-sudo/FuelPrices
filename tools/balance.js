#!/usr/bin/env node
// Симулация на кривата на прогресията на „Механата“.
//
// Играч, който купува винаги най-бързо изплащащото се (пост или ъпгрейд),
// без тапане. Ползва се за две неща:
//   1. да се види кога се появява първата бройка от всеки пост;
//   2. да се провери, че темпото попада в целевите прозорци на Алфа 0.3.
//
// Пуска се с: node tools/balance.js [--json] [--targets]
//
// Числата ТРЯБВА да съвпадат с GENS в mehanata.html. Ако ги промениш там,
// промени ги и тук, иначе проверката за темпо лъже.

export const GENS = [
  ['Ракия',              15,          0.1],
  ['Шопска салата',      100,         1],
  ['Мезе',               1100,        8],
  ['Скара',              12000,       47],
  ['Гайдар',             130000,      260],
  ['Изба',               1400000,     1400],
  ['Тераса',             20000000,    7800],
  ['Хоро',               330000000,   44000],
  ['Автобус',            5100000000,  260000],
  ['Верига механи',      75000000000, 1600000],
  // ---- отключвани от нивата на сградата, Алфа 0.3 ----
  ['Пивоварна',          1.125e12,    9.6e6],
  ['Винарна с етикет',   1.69e13,     5.76e7],
  ['Хотел към механата', 2.53e14,     3.46e8],
  ['Кулинарно предаване',3.8e15,      2.07e9],
  ['Износ зад граница',  5.7e16,      1.24e10]
];
export const GROWTH = 1.15;
export const UPG_STEPS = [10, 25, 50, 100, 150, 200, 300];

// Колко поста и колко нива ъпгрейди отключва всяко ниво на сградата.
export const BUILDINGS = [
  { name: 'Колиба',        posts: 10, upg: 4 },
  { name: 'Кръчма',        posts: 11, upg: 5 },
  { name: 'Механа',        posts: 12, upg: 5 },
  { name: 'Голяма механа', posts: 13, upg: 6 },
  { name: 'Хан',           posts: 14, upg: 6 },
  { name: 'Комплекс',      posts: 15, upg: 7 }
];

// Историческа база от Алфа 0.1, в секунди. Пази се като запис, вече НЕ е
// критерий — балансът се променя нарочно в 0.3.
export const BASELINE_V01 = {
  'Шопска салата': 100.0, 'Мезе': 747.8, 'Ракия': 749.2, 'Скара': 1316.9,
  'Гайдар': 2155.8, 'Изба': 3536.3, 'Тераса': 6693.4, 'Хоро': 14488.4,
  'Автобус': 33177.9, 'Верига механи': 84067.0
};

// Критериите за приемане на Алфа 0.3.
//
// Мери се ИЗЧЕРПВАНЕ НА СЪДЪРЖАНИЕТО — момента, в който всеки отключен пост е
// на последния си праг и всички негови ъпгрейди са купени, тоест няма какво
// повече да се купи. Точно това се случи в 0.2 за под час и накара играта да
// увисне. Множителят и нивото на сградата се движат заедно, защото играч с
// ×56 отдавна е стигнал Комплекс.
export const TARGETS_V03 = [
  // Първата звезда е единственото, което иска и таван — трябва да дойде
  // достатъчно рано, за да види играчът престижа, но не за пет минути.
  { name: 'първа звезда (×1)', mult: 1, building: 0, until: 1e6,
    min: 45 * 60, max: 75 * 60 },

  // Останалите имат смисъл само с долна граница. При здрав множител
  // изчерпването е далеч отвъд разумна игра — играчът прави престиж вместо
  // това, и точно това е желаният цикъл. ×1000 е нарочно извън достижимото:
  // предпазител, който ще падне, ако някой пак разлюлее множителя или
  // евтинизира постовете. За справка, в 0.2 при ×44 025 това беше 2.6 часа.
  { name: 'Колиба не се изчерпва (×6)',   mult: 6,    building: 0, exhaust: true, min: 30 * 24 * 3600 },
  { name: 'Колиба издържа и ×1000',       mult: 1000, building: 0, exhaust: true, min: 24 * 3600 },
  { name: 'Комплекс не се изчерпва (×56)',mult: 56,   building: 5, exhaust: true, min: 365 * 24 * 3600 }
];

// Таван на силата, която магазинът може да произведе. Заковано, защото точно
// това избяга в 0.2: там 1e18 изкарани даваха ×20 001 пасивно.
export const POWER_CEILING = { earned: 1e18, maxStars: 20000, maxMult: 100 };

/**
 * @param opts.mult      глобален множител (от магазина за звезди)
 * @param opts.building  индекс в BUILDINGS — определя постове и нива ъпгрейди
 * @param opts.until     спира, щом изкараното мине този праг
 */
export function simulate(opts = {}) {
  const mult = opts.mult ?? 1;
  const b = BUILDINGS[opts.building ?? BUILDINGS.length - 1];
  const nPosts = opts.posts ?? b.posts;
  const nUpg = opts.upg ?? b.upg;
  const until = opts.until ?? Infinity;
  const stopAtLast = until === Infinity && !opts.exhaust;
  // „изчерпано“ = всеки пост е на последния праг и всичките му ъпгрейди са купени
  const lastStep = UPG_STEPS[nUpg - 1];

  const own = new Array(nPosts).fill(0);
  const upg = new Array(nPosts).fill(0);
  let money = 0, t = 0, earned = 0, guard = 0;
  const first = {};

  const genCost = i => GENS[i][1] * Math.pow(GROWTH, own[i]);
  const upgCost = (i, k) => GENS[i][1] * 10 * Math.pow(5, k);
  const rate = () => own.reduce((s, c, i) => s + c * GENS[i][2] * Math.pow(2, upg[i]), 0) * mult;

  const exhausted = () => {
    for (let i = 0; i < nPosts; i++) if (own[i] < lastStep || upg[i] < nUpg) return false;
    return true;
  };
  while (guard++ < 2_000_000) {
    if (opts.exhaust ? exhausted() : (stopAtLast ? own[nPosts - 1] >= 1 : earned >= until)) break;
    let best = -1, bestPay = Infinity, kind = null, bestK = 0;
    for (let i = 0; i < nPosts; i++) {
      // В режим „изчерпване“ спираме да купуваме пост, стигнал последния праг.
      // Без този таван гредито трупа хиляди евтини Ракии и никога не стига
      // до скъпите постове, тоест краят не настъпва.
      if (opts.exhaust && own[i] >= lastStep) continue;
      const pay = genCost(i) / (GENS[i][2] * Math.pow(2, upg[i]) * mult);
      if (pay < bestPay) { bestPay = pay; best = i; kind = 'gen'; }
    }
    for (let i = 0; i < nPosts; i++) {
      if (upg[i] < nUpg && own[i] >= UPG_STEPS[upg[i]]) {
        const added = own[i] * GENS[i][2] * Math.pow(2, upg[i]) * mult;
        const pay = upgCost(i, upg[i]) / added;
        if (pay < bestPay) { bestPay = pay; best = i; kind = 'upg'; bestK = upg[i]; }
      }
    }
    const cost = kind === 'gen' ? genCost(best) : upgCost(best, bestK);
    const r = rate();
    if (money < cost) {
      const dt = r > 0 ? (cost - money) / r : (cost - money);
      t += dt; money += r * dt; earned += r * dt;
    }
    money -= cost;
    if (kind === 'gen') {
      if (own[best] === 0) first[GENS[best][0]] = t;
      own[best]++;
    } else upg[best]++;
  }
  return { first, total: t, earned, finalRate: rate() };
}

/** Колко звезди дава престиж при дадено изкарано — формулата на Алфа 0.3. */
export const starsFor = earned => Math.floor(Math.cbrt(earned / 1e6));

/** Цена на ниво в магазина за звезди и общата цена до дадено ниво. */
export const shopCost = level => Math.ceil(Math.pow(1.6, level));
export function shopLevelFor(stars) {
  let spent = 0, lv = 0;
  while (spent + shopCost(lv) <= stars) { spent += shopCost(lv); lv++; }
  return lv;
}

export function fmtTime(s) {
  s = Math.round(s);
  if (s < 3600) return (s / 60).toFixed(1) + ' мин';
  if (s < 86400) return (s / 3600).toFixed(1) + ' ч';
  return (s / 86400).toFixed(1) + ' дни';
}

/** Всяка цел -> {name, got, ok}. Ползва се и от tests/run.mjs. */
export function checkTargets() {
  const out = TARGETS_V03.map(t => {
    const { total } = simulate({ mult: t.mult, building: t.building,
                                 until: t.until, exhaust: t.exhaust });
    const ok = total >= t.min && (t.max === undefined || total <= t.max);
    return { name: t.name, got: total, min: t.min, max: t.max, ok };
  });
  // таванът на силата — не е време, затова се смята отделно
  const st = starsFor(POWER_CEILING.earned);
  const mult = Math.pow(1.25, shopLevelFor(st));
  out.push({
    name: 'таван на силата при 1e18',
    text: st + ' звезди → ×' + mult.toFixed(0),
    ok: st <= POWER_CEILING.maxStars && mult <= POWER_CEILING.maxMult
  });
  return out;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ targets: checkTargets(), curve: simulate({ building: 0 }) }, null, 2));
  } else {
    console.log('Първа бройка от всеки пост, Колиба (×1, без престиж, без тапане):\n');
    const { first, total } = simulate({ building: 0 });
    for (const [name, t] of Object.entries(first)) {
      const base = BASELINE_V01[name];
      const drift = base ? ((t - base) / base * 100) : null;
      const tag = drift === null ? '' :
        (Math.abs(drift) < 1 ? '   = как в 0.1' : `   ${drift > 0 ? '+' : ''}${drift.toFixed(0)}% спрямо 0.1`);
      console.log('  ' + name.padEnd(20) + fmtTime(t).padStart(9) + tag);
    }
    console.log('\nдо 10-ия пост: ' + fmtTime(total));

    console.log('\n\nЦелево темпо на Алфа 0.3:\n');
    let bad = 0;
    for (const r of checkTargets()) {
      if (!r.ok) bad++;
      const got = r.text !== undefined ? r.text : fmtTime(r.got);
      const window = r.text !== undefined ? '' :
        (r.max === undefined ? '   поне ' + fmtTime(r.min)
                             : '   прозорец ' + fmtTime(r.min) + ' – ' + fmtTime(r.max));
      console.log('  ' + (r.ok ? 'ok  ' : 'ВЪН ') + r.name.padEnd(30) + got.padStart(16) + window);
    }

    console.log('\n\nЗвезди и магазин:\n');
    for (const e of [1e6, 1e9, 1e12, 1e15, 1e18]) {
      const st = starsFor(e);
      console.log('  изкарано 1e' + String(Math.log10(e)).padStart(2) +
        ' → ' + String(st).padStart(6) + ' звезди → ниво ' +
        String(shopLevelFor(st)).padStart(2) +
        ' → ×' + Math.pow(1.25, shopLevelFor(st)).toFixed(0));
    }
    process.exit(bad ? 1 : 0);
  }
}
