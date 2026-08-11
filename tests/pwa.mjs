// PWA: манифест, икони, service worker и НАИСТИНА офлайн зареждане.
// Наборът сам вдига http сървър върху site/, защото service worker не
// работи на file:// — точно затова 0.1 не можеше да се сложи на началния екран.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { REPO, suite, check, eq } from './lib.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '': 'text/html; charset=utf-8'
};

function serve(dir) {
  return new Promise(res => {
    const srv = createServer(async (req, rq) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/' || p.endsWith('/')) p += 'index.html';
      try {
        const body = await readFile(resolve(dir, '.' + p));
        rq.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
        rq.end(body);
      } catch { rq.writeHead(404); rq.end('not found'); }
    });
    srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port }));
  });
}

export default async function run(browser) {
  const { srv, port } = await serve(resolve(REPO, 'site'));
  const origin = `http://127.0.0.1:${port}/`;
  try {
    /* ---------------- манифест и икони ---------------- */
    suite('манифест');
    const ctx = await browser.newContext({
      viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(origin);
    await page.waitForTimeout(700);

    const man = await page.evaluate(async () => {
      const link = document.querySelector('link[rel=manifest]');
      if (!link) return { error: 'няма link[rel=manifest]' };
      const r = await fetch(link.href);
      return { status: r.status, json: await r.json() };
    });
    check('страницата сочи към манифест', !man.error, man.error || '');
    eq('манифестът се сваля', man.status, 200);
    eq('display е standalone', man.json?.display, 'standalone');
    eq('името е Механата', man.json?.name, 'Механата');
    eq('темата съвпада с фона на играта', man.json?.theme_color, '#14100c');
    check('има maskable икона',
      (man.json?.icons || []).some(i => i.purpose === 'maskable'));

    const icons = await page.evaluate(async list => {
      const out = {};
      await Promise.all(list.map(i => new Promise(res => {
        const im = new Image();
        im.onload = () => { out[i.src] = im.naturalWidth + 'x' + im.naturalHeight; res(); };
        im.onerror = () => { out[i.src] = 'ГРЕШКА'; res(); };
        im.src = i.src;
      })));
      return out;
    }, man.json?.icons || []);
    eq('icon-192 е 192x192', icons['icon-192.png'], '192x192');
    eq('icon-512 е 512x512', icons['icon-512.png'], '512x512');
    eq('maskable е 512x512', icons['icon-512-maskable.png'], '512x512');

    /* ---------------- service worker ---------------- */
    suite('service worker');
    const reg = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.ready.catch(() => null);
      return r ? { scope: r.scope, active: !!r.active } : null;
    });
    check('service worker се регистрира', !!reg && reg.active, JSON.stringify(reg));

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      if (!names.length) return { names, keys: [] };
      const c = await caches.open(names[0]);
      return { names, keys: (await c.keys()).map(r => new URL(r.url).pathname) };
    });
    check('кешът е именуван по съдържание', /^mehanata-[0-9a-f]{12}$/.test(cached.names[0] || ''),
      cached.names.join(','));
    check('обвивката е в кеша', cached.keys.some(k => k.endsWith('index.html')),
      cached.keys.join(', '));
    check('иконите са в кеша', cached.keys.some(k => k.endsWith('icon-192.png')));

    /* ---------------- наистина офлайн ---------------- */
    suite('офлайн');
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(900);
    const offlineOK = await page.evaluate(() => ({
      money: document.getElementById('money')?.innerText || null,
      tap: !!document.getElementById('tapBtn'),
      rows: document.querySelectorAll('#genList .row').length,
      visible: [...document.querySelectorAll('#genList .row')]
        .filter(r => r.style.display !== 'none').length,
      icons: !!(window.MEHANA_ASSETS && Object.keys(window.MEHANA_ASSETS).length === 13)
    }));
    // всички постове са в DOM-а; видими са само отключените от сградата
    check('играта се зарежда без мрежа',
      offlineOK.tap && offlineOK.rows === 15 && offlineOK.visible >= 2,
      JSON.stringify(offlineOK));
    check('иконите оцеляват офлайн', offlineOK.icons);

    // и записът да оцелее презареждането без мрежа
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++)
        document.getElementById('tapBtn')
          .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      window.dispatchEvent(new Event('pagehide'));
    });
    await page.waitForTimeout(200);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(700);
    const taps = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('mehanata_save')).taps; } catch { return null; }
    });
    eq('записът оцелява офлайн презареждане', taps, 5);
    await ctx.setOffline(false);

    /* ---------------- инсталируемост ---------------- */
    suite('инсталируемост');
    const inst = await page.evaluate(() => ({
      https: location.protocol === 'https:' || location.hostname === '127.0.0.1',
      manifest: !!document.querySelector('link[rel=manifest]'),
      sw: !!navigator.serviceWorker.controller
    }));
    check('трите условия за инсталиране са налице',
      inst.https && inst.manifest && inst.sw, JSON.stringify(inst));

    const setTxt = await page.evaluate(async () => {
      document.getElementById('btnSettings').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      return document.getElementById('setPane').innerText;
    });
    check('Настройки казват как се добавя на началния екран',
      /началния екран/.test(setTxt));
    check('Настройки не се оплакват от паметта', !/НЕ работи/.test(setTxt));

    if (errs.length) check('без грешки в конзолата на сервираната версия', false, errs.join(' | '));
    await ctx.close();
  } finally {
    srv.close();
  }
}
