// Регресия: заключва поведението, доказано в Алфа 0.1.
// Всяка проверка тук е падала поне веднъж по време на разработката —
// не са декоративни.
import { withGame, tap, text, readSave, goTab, dragScroll, suite, check, eq, close } from './lib.mjs';

export default async function run(browser) {

  /* ---------------- форматиране на числа ---------------- */
  suite('форматиране');
  const FMT = [
    [1250, '1.25 хил.'], [3_400_000, '3.4 млн.'], [812e9, '812 млрд.'],
    [2.1e12, '2.1 трлн.'], [4.5e15, '4.5 квдрлн.'], [999, '999'],
    [0.1, '0.1'], [7.25e18, '7.25×10^18'], [1000, '1 хил.']
  ];
  for (const [v, want] of FMT) {
    await withGame(browser, { money: v }, async page => {
      const got = (await text(page, '#money')).replace(' лв.', '');
      eq(`fmt(${v})`, got, want);
    });
  }

  /* ---------------- видимост на постовете ---------------- */
  suite('отключване на постове');
  // постът се показва при 50% от базовата си цена, и то само след предния
  const VIS = [[0, 2], [50, 2], [600, 3], [6000, 4], [65_000, 5], [700_000, 6],
               [1e7, 7], [1.7e8, 8], [2.6e9, 9], [3.8e10, 10]];
  for (const [money, want] of VIS) {
    await withGame(browser, { money }, async page => {
      await page.waitForTimeout(350);
      const n = await page.evaluate(() =>
        [...document.querySelectorAll('#genList .row')].filter(r => r.style.display !== 'none').length);
      eq(`при ${money} лв. видими постове`, n, want);
    });
  }

  /* ---------------- цени и ъпгрейди ---------------- */
  suite('цени и ъпгрейди');
  await withGame(browser, { money: 1e7 }, async page => {
    for (let i = 0; i < 10; i++) await tap(page, '#genList .row[data-id="rakia"]');
    await page.waitForTimeout(250);
    const s = await readSave(page);
    eq('10 покупки дават 10 бройки', s.gens.rakia, 10);
    const shown = await text(page, '#genList .row[data-id="rakia"] .rprice');
    eq('цена след 10 бройки', shown, '60.7 лв.');          // 15 × 1.15^10 = 60.68

    await goTab(page, 'upg');
    await page.waitForTimeout(250);
    const p = await text(page, '#upgList .row[data-id="rakia_0"] .rprice');
    eq('цена на rakia_0', p, '150 лв.');                    // 15 × 10 × 5^0
    const before = await text(page, '#genList .row[data-id="rakia"] .rsub');
    await tap(page, '#upgList .row[data-id="rakia_0"]');
    await page.waitForTimeout(250);
    const after = await text(page, '#genList .row[data-id="rakia"] .rsub');
    check('ъпгрейдът удвоява поста', /2\.0\d/.test(after),
      `преди „${before}“, след „${after}“`);
  });

  /* ---------------- престиж ---------------- */
  suite('престиж');
  await withGame(browser, {
    money: 5e6, earnedRun: 9e6, earnedTotal: 9e6,
    gens: { rakia: 50 }, upgrades: { rakia_0: true }
  }, async page => {
    await goTab(page, 'star');
    await page.waitForTimeout(250);
    const label = await text(page, '#btnPrestige');
    check('floor(sqrt(9e6/1e6)) = 3 звезди', /за 3 звезди/.test(label), `бутон: „${label}“`);
    await tap(page, '#btnPrestige');
    await page.waitForTimeout(250);
    await page.locator('#mbox .btn').first().click();
    await page.waitForTimeout(400);
    const s = await readSave(page);
    eq('звездите се начисляват', s.stars, 3);
    eq('парите се нулират', Math.round(s.money), 0);
    eq('постовете се нулират', s.gens.rakia, 0);
    eq('ъпгрейдите се нулират', Object.keys(s.upgrades).length, 0);
    eq('броячът на престижи расте', s.prestiges, 1);
    eq('видимите постове се връщат на 2', Object.values(s.seen).filter(Boolean).length, 2);
    eq('рекордът на звездите се пази', s.bestStars, 3);
  });
  await withGame(browser, { earnedRun: 999_999 }, async page => {
    await goTab(page, 'star');
    await page.waitForTimeout(250);
    check('под 1 млн. престижът е недостъпен', await page.locator('#btnPrestige').isDisabled());
  });

  /* ---------------- офлайн ---------------- */
  suite('офлайн прогрес');
  const OFFLINE_GENS = { rakia: 100, salata: 100, meze: 50 };
  await withGame(browser, { gens: OFFLINE_GENS, savedAt: Date.now() - 3 * 3600e3 },
    async page => {
      await page.waitForTimeout(400);
      const m = await text(page, '#mbox');
      check('3 часа отсъствие показва модал', /Докато те нямаше/.test(m));
      check('без двойни точки в текста', !/лв\.\./.test(m), m.split('\n')[1] || '');
    });
  await withGame(browser, { gens: OFFLINE_GENS, savedAt: Date.now() - 30 * 3600e3 },
    async page => {
      await page.waitForTimeout(400);
      const m = await text(page, '#mbox');
      check('над 8 часа се капва', /само първите 8 часа/.test(m));
    });
  await withGame(browser, { gens: OFFLINE_GENS, savedAt: Date.now() - 5000 },
    async page => {
      await page.waitForTimeout(350);
      const on = await page.locator('#modalRoot').evaluate(e => e.classList.contains('on'));
      check('кратко отсъствие не вдига модал', !on);
    });

  /* ---------------- време: без двойно начисляване ---------------- */
  suite('времева база');
  await withGame(browser, { gens: { salata: 100 } }, async (page) => {
    // Скриването пуска save(), затова го ползваме и като точка на измерване —
    // автозаписът на 5 сек иначе не се вмества в прозореца на теста.
    const hide = () => page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const show = () => page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const rate = await page.evaluate(() => parseFloat(document.getElementById('rate').innerText));

    // Тук rAF НЕ спира (страницата реално е видима), а visibilitychange се
    // задейства — точно случаят, в който 0.1 плащаше времето два пъти.
    await hide();
    const t0 = Date.now();
    const m0 = (await readSave(page)).money;
    await page.waitForTimeout(4000);
    await show();
    await page.waitForTimeout(300);
    await hide();
    const m1 = (await readSave(page)).money;
    const elapsed = (Date.now() - t0) / 1000;
    close('приходът за периода се плаща веднъж', m1 - m0, rate * elapsed, 0.25);
  });

  /* ---------------- оформление ---------------- */
  suite('оформление');
  const SIZES = [[360, 640], [320, 480], [360, 560], [412, 915]];
  for (const [w, h] of SIZES) {
    await withGame(browser, { money: 9.9e17, stars: 9999, gens: {
      rakia: 999, salata: 999, meze: 999, skara: 999, gaida: 999,
      izba: 999, terasa: 999, horo: 999, avtobus: 999, mehana: 999
    } }, async page => {
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => ({
        hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        small: (() => {
          const out = [];
          ['#tapBtn', 'nav button', '.hbtn', '.btn', '.xbtn', '.row'].forEach(s =>
            document.querySelectorAll(s).forEach(e => {
              const b = e.getBoundingClientRect();
              if (b.width > 0 && (b.width < 48 || b.height < 48)) out.push(s + ' ' + Math.round(b.width) + 'x' + Math.round(b.height));
            }));
          return out;
        })(),
        navBottom: Math.round(document.querySelector('nav').getBoundingClientRect().bottom),
        vh: window.innerHeight
      }));
      check(`${w}×${h}: без хоризонтално скролване`, !r.hscroll);
      check(`${w}×${h}: всички цели ≥48 px`, r.small.length === 0, r.small.join(', '));
      check(`${w}×${h}: таб барът е в екрана`, r.navBottom <= r.vh + 1, `дъно ${r.navBottom}, екран ${r.vh}`);
    }, { viewport: { width: w, height: h } });
  }

  /* ---------------- скрол с пръст ---------------- */
  suite('скрол');
  await withGame(browser, {
    money: 4e6, stars: 12, prestiges: 3, earnedRun: 8.5e6,
    gens: { rakia: 64, salata: 41, meze: 28, skara: 15, gaida: 6 }, upgrades: { rakia_0: true }
  }, async (page, ctx) => {
    for (const [scr, sel] of [['mehana', '#genList'], ['upg', '#upgList'], ['star', '#starPane']]) {
      await goTab(page, scr);
      await page.waitForTimeout(300);
      const r = await dragScroll(page, ctx, sel);
      check(`${scr}: списъкът скролва с пръст`, r.max > 0 && r.top > 0,
        `scrollTop ${r.top} от ${r.max}`);
    }
  });

  /* ---------------- икони ---------------- */
  suite('икони');
  await withGame(browser, {}, async page => {
    const r = await page.evaluate(async () => {
      const A = window.MEHANA_ASSETS, sizes = {};
      await Promise.all(Object.keys(A).map(k => new Promise(res => {
        const im = new Image();
        im.onload = () => { sizes[k] = im.naturalWidth + 'x' + im.naturalHeight; res(); };
        im.onerror = () => { sizes[k] = 'ГРЕШКА'; res(); };
        im.src = A[k];
      })));
      return { keys: Object.keys(A), sizes,
        broken: [...document.querySelectorAll('img')].filter(i => i.offsetParent !== null && i.naturalWidth === 0).length };
    });
    eq('13 ключа', r.keys.length, 13);
    const bad = Object.entries(r.sizes).filter(([, v]) => v === 'ГРЕШКА' || v === '0x0');
    check('всички икони се декодират', bad.length === 0, JSON.stringify(bad));
    eq('иконата fon е 960x540', r.sizes.fon, '960x540');
    eq('нула счупени <img> в DOM', r.broken, 0);
  });

  /* ---------------- запис ---------------- */
  suite('запис');
  await withGame(browser, { money: 1e6, gens: { rakia: 12 } }, async page => {
    const before = (await readSave(page)).gens.rakia;
    await tap(page, '#genList .row[data-id="rakia"]');
    await page.waitForTimeout(250);
    eq('покупката се записва веднага', (await readSave(page)).gens.rakia, before + 1);
    await goTab(page, 'upg');
    await page.waitForTimeout(250);
    await tap(page, '#upgList .row[data-id="rakia_0"]');
    await page.waitForTimeout(250);
    eq('ъпгрейдът се записва веднага',
      Object.keys((await readSave(page)).upgrades).length, 1);
  });

  // Недостъпна памет: играта трябва да каже защо, а не да мълчи
  suite('недостъпна памет');
  await withGame(browser, null, async page => {
    await page.waitForTimeout(1200);
    const m = await text(page, '#mbox');
    check('обяснителен модал при отказ на localStorage', /Записът не работи/.test(m || ''));
    await page.locator('#mbox .btn').first().click();
    await page.waitForTimeout(200);
    await tap(page, '#tapBtn');
    await page.waitForTimeout(250);
    check('играта остава играема без памет', (await text(page, '#money')) !== '0 лв.');
    await page.evaluate(() => document.getElementById('btnSettings')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(300);
    check('Настройки показват червен статус', /НЕ работи/.test(await text(page, '#setStorage')));
  }, {
    initScript: () => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { throw new DOMException('Access is denied for this document.', 'SecurityError'); }
      });
    }
  });

  /* ---------------- резервно копие ---------------- */
  suite('резервно копие');
  await withGame(browser, {
    money: 777_777, gens: { rakia: 33, salata: 22 }, upgrades: { rakia_0: true },
    stars: 9, prestiges: 2, taps: 555
  }, async page => {
    await page.evaluate(() => document.getElementById('btnSettings')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(300);
    await tap(page, '#btnCopy');
    await page.waitForTimeout(350);
    const exported = await page.locator('#saveBox').inputValue();
    const parsed = JSON.parse(exported);
    eq('изнесеното пази звездите', parsed.stars, 9);
    eq('изнесеното пази тапванията', parsed.taps, 555);

    await tap(page, '#btnWipe');
    await page.waitForTimeout(300);
    await page.locator('#mbox .btn.danger').click();
    await page.waitForTimeout(450);
    eq('след изтриване звездите са 0', await text(page, '#starNum'), '0');

    await page.evaluate(() => document.getElementById('btnSettings')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(250);
    await tap(page, '#btnPaste');
    await page.waitForTimeout(250);
    await page.locator('#saveBox').fill(exported);
    await tap(page, '#btnPaste');
    await page.waitForTimeout(350);
    await page.locator('#mbox .btn').first().click();
    await page.waitForTimeout(500);
    const back = await readSave(page);
    eq('възстановените звезди', back.stars, 9);
    eq('възстановената ракия', back.gens.rakia, 33);
    eq('възстановените тапвания', back.taps, 555);
    eq('възстановените ъпгрейди', Object.keys(back.upgrades).length, 1);
  });
}
