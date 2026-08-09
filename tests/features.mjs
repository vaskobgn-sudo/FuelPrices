// Новото в Алфа 0.2: покупка на едро, прагове на звездите, критичен тап,
// трето събитие, миграция на записа.
import { withGame, tap, text, readSave, goTab, suite, check, eq, close } from './lib.mjs';

const GROWTH = 1.15;
/** Същата формула, сметната независимо от играта — иначе тестът е тавтология. */
function expectedBulk(base, n, k) {
  return base * Math.pow(GROWTH, k) * (Math.pow(GROWTH, n) - 1) / (GROWTH - 1);
}
const RAKIA = 15, SALATA = 100;

const setMode = (page, mode) => page.evaluate(m => {
  document.querySelector(`#buyBar button[data-mode="${m}"]`)
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, mode);

export default async function run(browser) {

  /* ---------------- покупка на едро ---------------- */
  suite('покупка на едро');

  for (const mode of [10, 100]) {
    await withGame(browser, { money: 1e12, gens: { rakia: 0 } }, async page => {
      await setMode(page, mode);
      await page.waitForTimeout(150);
      const before = (await readSave(page)).money;
      await tap(page, '#genList .row[data-id="rakia"]');
      await page.waitForTimeout(250);
      const s = await readSave(page);
      eq(`×${mode} купува точно ${mode} бройки`, s.gens.rakia, mode);
      // приходът тече, затова сравняваме разхода с толеранс
      close(`×${mode} взима правилната сума`, before - s.money, expectedBulk(RAKIA, mode, 0), 0.02);
      eq(`×${mode} брои покупка на едро`, s.bulkBuys, 1);
    });
  }

  // покупката на едро продължава от вече притежаваните, не от нула
  await withGame(browser, { money: 1e12, gens: { salata: 37 } }, async page => {
    await setMode(page, 10);
    await page.waitForTimeout(150);
    const before = (await readSave(page)).money;
    await tap(page, '#genList .row[data-id="salata"]');
    await page.waitForTimeout(250);
    const s = await readSave(page);
    eq('×10 върху 37 бройки дава 47', s.gens.salata, 47);
    close('цената тръгва от 37-ата бройка', before - s.money, expectedBulk(SALATA, 10, 37), 0.02);
  });

  // при недостиг НЕ купуваме частично
  await withGame(browser, { money: expectedBulk(RAKIA, 10, 0) * 0.5 }, async page => {
    await setMode(page, 10);
    await page.waitForTimeout(150);
    await tap(page, '#genList .row[data-id="rakia"]');
    await page.waitForTimeout(250);
    const s = await readSave(page);
    eq('при недостиг ×10 не купува нищо', s.gens.rakia, 0);
  });

  // Макс купува колкото стигат парите — точно, без една в повече
  for (const want of [1, 7, 23]) {
    const exact = expectedBulk(RAKIA, want, 0);
    await withGame(browser, { money: exact * 1.0001 }, async page => {
      await setMode(page, 0);
      await page.waitForTimeout(200);
      await tap(page, '#genList .row[data-id="rakia"]');
      await page.waitForTimeout(250);
      const s = await readSave(page);
      // приходът е 0 в началото, така че границата е чиста
      check(`Макс при пари точно за ${want} купува ${want}`, s.gens.rakia === want,
        `купи ${s.gens.rakia}`);
    });
  }

  await withGame(browser, { money: 1e6, buyMode: 100 }, async page => {
    const on = await page.evaluate(() =>
      document.querySelector('#buyBar button.on')?.dataset.mode);
    eq('режимът на покупка се помни от записа', on, '100');
  });

  /* ---------------- прагове на звездите ---------------- */
  suite('прагове на звездите');

  await withGame(browser, { stars: 4, gens: { salata: 100 }, savedAt: Date.now() - 30 * 3600e3 },
    async page => {
      await page.waitForTimeout(400);
      check('под 5 звезди таванът е 8 часа', /първите 8 часа/.test(await text(page, '#mbox')));
    });
  await withGame(browser, { stars: 5, gens: { salata: 100 }, savedAt: Date.now() - 30 * 3600e3 },
    async page => {
      await page.waitForTimeout(400);
      const m = await text(page, '#mbox');
      check('на 5 звезди таванът става 12 часа', /първите 12 часа/.test(m), m.split('\n')[2] || '');
    });
  await withGame(browser, { stars: 100, gens: { salata: 100 }, savedAt: Date.now() - 3 * 3600e3 },
    async page => {
      await page.waitForTimeout(400);
      check('на 100 звезди офлайн приходът е 100%', /100% от прихода/.test(await text(page, '#mbox')));
    });

  // тапът се удвоява на 25 звезди — сравняваме при еднакъв приход
  const tapAt = async stars => withGame(browser, { stars, gens: { salata: 1000 } }, async page => {
    await page.waitForTimeout(300);
    return page.evaluate(() => document.getElementById('tapHint').innerText);
  });
  const t24 = await tapAt(24), t25 = await tapAt(25);
  const num = s => parseFloat(String(s).replace(/[^\d.]/g, ''));
  close('на 25 звезди тапът е двойно спрямо 24', num(t25) / num(t24),
    2 * (1 + 0.02 * 25) / (1 + 0.02 * 24), 0.03);

  await withGame(browser, { stars: 25 }, async page => {
    await goTab(page, 'star');
    await page.waitForTimeout(300);
    const got = await page.evaluate(() =>
      [...document.querySelectorAll('#tierList .achv')].map(d => d.classList.contains('got')));
    eq('на 25 звезди са отключени 3 прага', got.filter(Boolean).length, 3);
  });

  /* ---------------- критичен тап ---------------- */
  suite('критичен тап');
  await withGame(browser, { gens: { salata: 100 } }, async page => {
    await page.waitForTimeout(300);
    const base = await page.evaluate(() =>
      parseFloat(document.getElementById('tapHint').innerText.replace(/[^\d.]/g, '')));
    const before = (await readSave(page)).money;
    await tap(page, '#tapBtn');
    await page.waitForTimeout(200);
    const s = await readSave(page);
    eq('критът се брои', s.crits, 1);
    check('критът дава десетократно', (s.money - before) > base * 8,
      `спечелено ${(s.money - before).toFixed(1)} при базов тап ${base.toFixed(1)}`);
    check('критът се показва в изскачащото число',
      await page.evaluate(() => !!document.querySelector('.float.crit')));
  }, { initScript: () => { Math.random = () => 0.001; } });     // винаги крит

  await withGame(browser, {}, async page => {
    await tap(page, '#tapBtn');
    await page.waitForTimeout(200);
    eq('без крит броячът стои', (await readSave(page)).crits, 0);
  }, { initScript: () => { Math.random = () => 0.99; } });      // никога крит

  /* ---------------- трето събитие ---------------- */
  suite('събитие с автобуса');
  await withGame(browser, { money: 1e8, gens: { rakia: 3, salata: 2, meze: 1 } }, async page => {
    await page.waitForTimeout(400);
    const before = await readSave(page);
    await page.evaluate(() => {
      Math.random = () => 0.9;                                   // третият клон
      document.getElementById('eventHost').classList.add('on');
    });
    await tap(page, '#eventBtn');
    await page.waitForTimeout(400);
    const after = await readSave(page);
    const seen = Object.values(before.seen).filter(Boolean).length;
    eq('всеки видим пост получава по 1 бройка', after.freeGifts, seen);
    eq('ракията расте с 1', after.gens.rakia, before.gens.rakia + 1);
    check('казва се в toast', /Автобус спря/.test(await text(page, '#toasts')));
  });

  /* ---------------- миграция на записа ---------------- */
  suite('миграция 1 → 2');
  await withGame(browser, {
    version: 1, money: 12345, stars: 7, prestiges: 2, taps: 400,
    gens: { rakia: 20, salata: 10 }, upgrades: { rakia_0: true }, achv: { a1: true, a9: true }
  }, async page => {
    await page.waitForTimeout(400);
    const s = await readSave(page);
    eq('версията се вдига на 2', s.version, 2);
    eq('парите оцеляват', Math.round(s.money) >= 12345, true);
    eq('звездите оцеляват', s.stars, 7);
    eq('постовете оцеляват', s.gens.rakia, 20);
    eq('ъпгрейдите оцеляват', Object.keys(s.upgrades).length, 1);
    eq('новото поле buyMode получава стойност', s.buyMode, 1);
    eq('новото поле crits получава стойност', s.crits, 0);
    check('няма undefined в записа', !JSON.stringify(s).includes('null'), JSON.stringify(s).slice(0, 120));
  });

  /* ---------------- пренасяне на запис от 0.1 през интерфейса ---------------- */
  // Пътят, по който играч мести прогреса си на нов адрес: „Копирай записа“
  // в старата версия, „Възстанови от текст“ в новата. Текстът тук е точно
  // във формата, който Алфа 0.1 изнася — без полетата, добавени в 0.2.
  suite('пренасяне на запис от 0.1');
  const V01_EXPORT = JSON.stringify({
    version: 1, money: 8123456,
    gens: { rakia: 73, salata: 55, meze: 31, skara: 18, gaida: 9, izba: 3 },
    seen: { rakia: true, salata: true, meze: true, skara: true, gaida: true, izba: true, terasa: true },
    upgrades: { rakia_0: true, rakia_1: true, salata_0: true, meze_0: true, skara_0: true },
    stars: 14, prestiges: 3, earnedRun: 6.2e6, earnedTotal: 4.4e8,
    taps: 1877, playtime: 11200, peakMoney: 1.2e7, bestRate: 22000, bestStars: 14,
    achv: { a1: true, a2: true, a4: true, a5: true, a6: true },
    eventsCaught: 6, muted: true, boostUntil: 0, savedAt: Date.now()
  });
  await withGame(browser, null, async page => {
    await page.evaluate(() => document.getElementById('btnSettings')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(250);
    await tap(page, '#btnPaste');
    await page.waitForTimeout(250);
    await page.locator('#saveBox').fill(V01_EXPORT);
    await tap(page, '#btnPaste');
    await page.waitForTimeout(300);
    await page.locator('#mbox .btn').first().click();
    await page.waitForTimeout(500);
    const s = await readSave(page);
    eq('парите се пренасят', Math.round(s.money) >= 8123456, true);
    eq('звездите се пренасят', s.stars, 14);
    eq('престижите се пренасят', s.prestiges, 3);
    eq('тапванията се пренасят', s.taps, 1877);
    eq('постовете се пренасят', s.gens.rakia, 73);
    eq('ъпгрейдите се пренасят', Object.keys(s.upgrades).length, 5);
    eq('изиграното време се пренася', Math.round(s.playtime) >= 11200, true);
    eq('записът става версия 2', s.version, 2);
    eq('новите полета получават стойности', s.buyMode, 1);
    check('екранът показва пренесените пари',
      /млн\. лв\./.test(await text(page, '#money')), await text(page, '#money'));
  });

  /* ---------------- версия и постижения ---------------- */
  suite('версия и постижения');
  await withGame(browser, {}, async page => {
    eq('30 постижения', await page.evaluate(() => document.querySelectorAll('#achvList .achv').length), 30);
    await page.evaluate(() => document.getElementById('btnSettings')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(300);
    check('версията се вижда в Настройки', /Алфа 0\.2/.test(await text(page, '#setPane')));
    check('дневникът на промените се вижда', /Дневник на промените/.test(await text(page, '#setPane')));
  });
}
