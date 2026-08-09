// Генериран от tools/build-site.js — не го редактирай на ръка.
// Версия на играта: Алфа 0.2
const CACHE = 'mehanata-b2a42b57ba56';
const ASSETS = ["./","index.html","manifest.webmanifest","icon-192.png","icon-512.png","icon-512-maskable.png","apple-touch-icon.png"];

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
