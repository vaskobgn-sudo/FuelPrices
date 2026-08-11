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

  /* ---------------- сградата ---------------- */
  suite('сградата');
  // Кръчма струва 3e12 и отключва Пивоварна плюс ъпгрейди до 150 бройки
  await withGame(browser, { money: 4e12, gens: { rakia: 200 } }, async page => {
    await goTab(page, 'star');
    await page.waitForTimeout(300);
    check('показва текущото ниво', /Колиба/.test(await text(page, '#bName')));
    const vis = () => page.evaluate(() =>
      [...document.querySelectorAll('#genList .row')].filter(r => r.style.display !== 'none')
        .map(r => r.dataset.id));
    await goTab(page, 'mehana');
    await page.waitForTimeout(300);
    check('Пивоварна още я няма', !(await vis()).includes('pivo'));
    await goTab(page, 'upg');
    await page.waitForTimeout(300);
    const upgVisible = () => page.evaluate(() =>
      [...document.querySelectorAll('#upgList .row')].filter(r => r.style.display !== 'none')
        .map(r => r.dataset.id));
    check('петото ниво ъпгрейди още го няма при 200 ракии',
      !(await upgVisible()).includes('rakia_4'));

    await goTab(page, 'star');
    await page.waitForTimeout(300);
    await tap(page, '#btnBuild');
    await page.waitForTimeout(300);
    check('диалогът казва какво отключва', /Пивоварна/.test(await text(page, '#mbox')));
    await page.locator('#mbox .btn').first().click();
    await page.waitForTimeout(600);
    const s = await readSave(page);
    eq('нивото се вдига', s.building, 1);
    eq('цената се удържа', Math.round(s.money) < 1.1e12, true);
    await goTab(page, 'upg');
    await page.waitForTimeout(400);
    check('петото ниво ъпгрейди се отключва', (await upgVisible()).includes('rakia_4'));
  });

  await withGame(browser, { money: 1e6 }, async page => {
    await goTab(page, 'star');
    await page.waitForTimeout(300);
    check('без пари бутонът за строеж е изключен',
      await page.locator('#btnBuild').isDisabled());
  });

  await withGame(browser, { money: 1e18, building: 5 }, async page => {
    await goTab(page, 'star');
    await page.waitForTimeout(300);
    check('на последно ниво бутонът изчезва',
      await page.evaluate(() => document.getElementById('btnBuild').style.display === 'none'));
    const vis = await page.evaluate(() =>
      [...document.querySelectorAll('#genList .row')].filter(r => r.style.display !== 'none').length);
    eq('Комплексът дава всичките 15 поста', vis, 15);
  });

  /* ---------------- Дядовата изба ---------------- */
  suite('магазин за звезди');
  await withGame(browser, { stars: 100, starsTotal: 100, gens: { salata: 100 } }, async page => {
    await page.waitForTimeout(300);
    const rate0 = await page.evaluate(() => parseFloat(document.getElementById('rate').innerText));
    await goTab(page, 'star');
    await page.waitForTimeout(300);
    await tap(page, '#shopList .row[data-shop="recipe"]');
    await page.waitForTimeout(350);
    const s = await readSave(page);
    eq('умението се вдига на ниво 1', s.starShop.recipe, 1);
    eq('цената е 1 звезда', s.stars, 99);
    eq('похарченото се брои', s.starsSpent, 1);
    await goTab(page, 'mehana');
    await page.waitForTimeout(300);
    const rate1 = await page.evaluate(() => parseFloat(document.getElementById('rate').innerText));
    close('приходът расте с 25%', rate1 / rate0, 1.25, 0.02);
  });

  // Харченето НЕ бива да отнема вече отключени прагове — те ключат на
  // изкараните за цял живот звезди, не на наличните.
  await withGame(browser, { stars: 30, starsTotal: 30 }, async page => {
    await goTab(page, 'star');
    await page.waitForTimeout(300);
    const tiers = () => page.evaluate(() =>
      [...document.querySelectorAll('#tierList .achv')].filter(d => d.classList.contains('got')).length);
    eq('при 30 изкарани звезди са отключени 3 прага', await tiers(), 3);
    for (let i = 0; i < 6; i++) { await tap(page, '#shopList .row[data-shop="recipe"]'); await page.waitForTimeout(120); }
    const s = await readSave(page);
    check('звездите наистина са похарчени', s.stars < 30, `остават ${s.stars}`);
    eq('праговете остават отключени', await tiers(), 3);
  });

  await withGame(browser, { stars: 0, starsTotal: 0 }, async page => {
    await goTab(page, 'star');
    await page.waitForTimeout(300);
    await tap(page, '#shopList .row[data-shop="recipe"]');
    await page.waitForTimeout(250);
    eq('без звезди не се купува', (await readSave(page)).starShop.recipe, undefined);
  });

  // „Изгодни доставки“ намалява поскъпването — цената на 10 бройки пада
  await withGame(browser, { stars: 500, starsTotal: 500, money: 1e9 }, async page => {
    const priceOf = () => page.evaluate(() =>
      document.querySelector('#genList .row[data-id="rakia"] .rprice').innerText);
    await setMode(page, 10);
    await page.waitForTimeout(200);
    const before = priceOf();
    await goTab(page, 'star');
    await page.waitForTimeout(250);
    await tap(page, '#shopList .row[data-shop="supply"]');
    await page.waitForTimeout(300);
    await goTab(page, 'mehana');
    await page.waitForTimeout(300);
    const [b, a] = [await before, await priceOf()];
    const num = t => parseFloat(t.replace(/[^\d.]/g, ''));
    check('поскъпването намалява', num(a) < num(b), `преди ${b}, след ${a}`);
  });

  /* ---------------- ребалансът на 0.3 ---------------- */
  // Запис отпреди версия 3 НЕ се пренася както е — старата формула даваше
  // ×34 000 в икономика, мерена в единици. Вместо това: чист старт плюс
  // звезди, изчислени по новата формула от изкараното за цял живот.
  suite('ребаланс 0.3');
  await withGame(browser, {
    version: 2, money: 12345, stars: 500000, prestiges: 12, taps: 9601,
    earnedTotal: 1.4e18, playtime: 17460,
    gens: { rakia: 100, salata: 80 }, upgrades: { rakia_0: true, rakia_1: true },
    achv: { a1: true, a9: true }
  }, async page => {
    await page.waitForTimeout(600);
    const s = await readSave(page);
    eq('версията става 3', s.version, 3);
    eq('парите се нулират', Math.round(s.money) < 1000, true);
    eq('постовете се нулират', s.gens.rakia, 0);
    eq('ъпгрейдите се нулират', Object.keys(s.upgrades).length, 0);
    // cbrt(1.4e18 / 1e6) = 11186 — делителят е PRESTIGE_MIN, същият като в симулацията
    eq('компенсацията е по новата формула', s.stars, 11186);
    eq('и се брои като изкарана', s.starsTotal, 11186);
    eq('звездите паднаха от 500 000', s.stars < 20000, true);
    eq('историята се пази', Math.round(s.earnedTotal), 1.4e18);
    eq('тапванията се пазят', s.taps, 9601);
    eq('престижите се пазят', s.prestiges, 12);
    check('маркиран е като ветеран', s.veteran === true);
    check('обяснителният модал се показва',
      /Механата е преустроена/.test(await text(page, '#mbox') || ''));
  });

  // Загуба на прогрес НЕ бива да може да се заобиколи чрез внасяне на стар
  // запис през „Възстанови от текст“ — иначе ребалансът е доброволен.
  suite('старият запис не заобикаля ребаланса');
  const OLD_EXPORT = JSON.stringify({
    version: 2, money: 8e17, stars: 1706372, prestiges: 12, taps: 9601,
    earnedTotal: 1.4e18, gens: { rakia: 100, salata: 80, meze: 61 },
    upgrades: { rakia_0: true, rakia_1: true, rakia_2: true }, achv: { a1: true }
  });
  await withGame(browser, null, async page => {
    await page.evaluate(() => document.getElementById('btnSettings')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(250);
    await tap(page, '#btnPaste');
    await page.waitForTimeout(250);
    await page.locator('#saveBox').fill(OLD_EXPORT);
    await tap(page, '#btnPaste');
    await page.waitForTimeout(300);
    await page.locator('#mbox .btn').first().click();
    await page.waitForTimeout(500);
    const s = await readSave(page);
    eq('внесеният стар запис също минава през ребаланса', s.stars, 11186);
    eq('парите му не се пренасят', Math.round(s.money) < 1000, true);
    eq('постовете му не се пренасят', s.gens.rakia, 0);
    eq('но историята се признава', Math.round(s.earnedTotal), 1.4e18);
  });

  /* ---------------- пренасяне между адреси в рамките на 0.3 ---------------- */
  // Пътят, по който играч мести прогреса си на нов адрес. От версия 3 нататък
  // записът се пренася както е — ребалансът важи само за по-старите.
  suite('пренасяне на запис в рамките на 0.3');
  const V03_EXPORT = JSON.stringify({
    version: 3, money: 8123456,
    gens: { rakia: 73, salata: 55, meze: 31, skara: 18, gaida: 9, izba: 3 },
    seen: { rakia: true, salata: true, meze: true, skara: true, gaida: true, izba: true },
    upgrades: { rakia_0: true, rakia_1: true, salata_0: true, meze_0: true, skara_0: true },
    stars: 14, starsTotal: 40, starsSpent: 26, starShop: { recipe: 5, tongue: 2 },
    building: 2, prestiges: 3, earnedRun: 6.2e6, earnedTotal: 4.4e8,
    taps: 1877, playtime: 11200, peakMoney: 1.2e7, bestRate: 22000, bestStars: 40,
    achv: { a1: true, a2: true }, eventsCaught: 6, muted: true, savedAt: Date.now()
  });
  await withGame(browser, null, async page => {
    await page.evaluate(() => document.getElementById('btnSettings')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(250);
    await tap(page, '#btnPaste');
    await page.waitForTimeout(250);
    await page.locator('#saveBox').fill(V03_EXPORT);
    await tap(page, '#btnPaste');
    await page.waitForTimeout(300);
    await page.locator('#mbox .btn').first().click();
    await page.waitForTimeout(500);
    const s = await readSave(page);
    eq('парите се пренасят', Math.round(s.money) >= 8123456, true);
    eq('свободните звезди се пренасят', s.stars, 14);
    eq('изкараните звезди се пренасят', s.starsTotal, 40);
    eq('купените умения се пренасят', s.starShop.recipe, 5);
    eq('сградата се пренася', s.building, 2);
    eq('постовете се пренасят', s.gens.rakia, 73);
    eq('ъпгрейдите се пренасят', Object.keys(s.upgrades).length, 5);
    check('екранът показва пренесените пари',
      /млн\. лв\./.test(await text(page, '#money')), await text(page, '#money'));
  });

  /* ---------------- версия и постижения ---------------- */
  suite('версия и постижения');
  await withGame(browser, {}, async page => {
    eq('39 постижения', await page.evaluate(() => document.querySelectorAll('#achvList .achv').length), 39);
    await page.evaluate(() => document.getElementById('btnSettings')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(300);
    check('версията се вижда в Настройки', /Алфа 0\.2/.test(await text(page, '#setPane')));
    check('дневникът на промените се вижда', /Дневник на промените/.test(await text(page, '#setPane')));
  });
}
