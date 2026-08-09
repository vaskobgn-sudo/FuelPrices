#!/usr/bin/env node
// Прави site/ от mehanata.html.
//
// mehanata.html остава единственият източник на истина и остава играем
// направо от диск. Тук само се добавят нещата, които имат смисъл единствено
// при хостинг: връзка към манифеста, иконата за Apple и service worker с
// версия, вързана за съдържанието.
//
//   node tools/build-site.js
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(REPO, 'site');
mkdirSync(OUT, { recursive: true });

const game = readFileSync(resolve(REPO, 'mehanata.html'), 'utf8');
const version = readFileSync(resolve(REPO, 'mehanata.html'), 'utf8')
  .match(/var GAME_VERSION='([^']+)'/)?.[1] || 'неизвестна';

/* ---------- index.html ---------- */
const HEAD_EXTRA =
  '<link rel="manifest" href="manifest.webmanifest">\n' +
  '<link rel="apple-touch-icon" href="apple-touch-icon.png">\n' +
  '<link rel="icon" href="icon-192.png" type="image/png">\n';

if (!game.includes('</title>')) throw new Error('няма </title> за котва');
const html = game.replace('</title>', '</title>\n' + HEAD_EXTRA);
writeFileSync(resolve(OUT, 'index.html'), html);

/* ---------- manifest ---------- */
const manifest = {
  name: 'Механата',
  short_name: 'Механата',
  description: 'Българска idle игра за механа. Налей ракия, събери звезди.',
  lang: 'bg',
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#14100c',
  theme_color: '#14100c',
  categories: ['games'],
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
};
writeFileSync(resolve(OUT, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));

/* ---------- service worker ---------- */
const ASSETS = ['./', 'index.html', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png'];

for (const a of ASSETS.slice(3)) {
  if (!existsSync(resolve(OUT, a))) throw new Error(`липсва ${a} — пусни node tools/make-icons.js`);
}

// Версията на кеша виси на съдържанието на самата игра. Всяка промяна в
// mehanata.html дава друг sw.js, браузърът вижда различен байт и пуска
// обновяване — иначе новата версия не стига до вече инсталираните.
const hash = createHash('sha256').update(html).digest('hex').slice(0, 12);

const sw = `// Генериран от tools/build-site.js — не го редактирай на ръка.
// Версия на играта: ${version}
const CACHE = 'mehanata-${hash}';
const ASSETS = ${JSON.stringify(ASSETS)};

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Играта е един файл — кешът пръв дава мигновено пускане и работа офлайн.
// Свежестта идва от обновяването на самия service worker, не от всяка заявка.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.status === 200 && res.type === 'basic') {
        const c = await caches.open(CACHE);
        c.put(req, res.clone());
      }
      return res;
    } catch (err) {
      // навигация без мрежа и без точно съвпадение → връщаме обвивката
      if (req.mode === 'navigate') {
        const shell = await caches.match('index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

// Страницата иска новата версия веднага след като потребителят е потвърдил.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
`;
writeFileSync(resolve(OUT, 'sw.js'), sw);

// GitHub Pages иначе прекарва всичко през Jekyll
writeFileSync(resolve(OUT, '.nojekyll'), '');

console.log('site/ е готов');
console.log('  версия на играта: ' + version);
console.log('  кеш: mehanata-' + hash);
console.log('  index.html: ' + (html.length / 1024).toFixed(0) + ' KB');
