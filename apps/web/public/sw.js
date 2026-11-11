// Service worker minimal : coque de l'application disponible hors ligne.
// Seuls les fichiers de même origine sont mis en cache ; jamais les réponses
// des serveurs Plex (elles contiennent des jetons dans leurs URL).
const CACHE = 'multiplex-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const put = (res) => {
    if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
    return res;
  };
  if (url.pathname.includes('/assets/')) {
    // Fichiers au nom haché : immuables.
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then(put)));
  } else {
    e.respondWith(
      fetch(e.request)
        .then(put)
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./'))),
    );
  }
});
