/* eslint-disable no-restricted-globals */
/**
 * Service Worker classico (compativel com GitHub Pages e navegadores antigos).
 *
 * Estrategias:
 *  - APP SHELL / assets: CACHE FIRST
 *  - datasets (./data/*.json): STALE WHILE REVALIDATE
 *  - navegacao: NETWORK FIRST com fallback para index.html (offline)
 *
 * IMPORTANTE: manter CACHE_VERSION em sincronia com src/js/config.js.
 */

const CACHE_VERSION = 'lottery-engine-v1';
const CACHE_NAME = `lottery-engine-cache-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './src/css/style.css',
  './src/css/components.css',
  './src/css/responsive.css',
  './src/js/app.js',
  './src/js/accessibility.js',
  './src/js/backtest-engine.js',
  './src/js/bitmask.js',
  './src/js/charts.js',
  './src/js/combination-engine.js',
  './src/js/config.js',
  './src/js/data-loader.js',
  './src/js/db.js',
  './src/js/export.js',
  './src/js/formatter.js',
  './src/js/game-profiles.js',
  './src/js/logger.js',
  './src/js/monte-carlo.js',
  './src/js/notifications.js',
  './src/js/scoring-engine.js',
  './src/js/state.js',
  './src/js/statistics.js',
  './src/js/ui.js',
  './src/js/validator.js',
  './src/js/worker-client.js',
  './src/workers/worker.js',
  './data/lotofacil.json',
  './data/megasena.json',
];

const DATA_PATTERN = /\/data\/[^/]+\.json$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // addAll falha por inteiro se um recurso falhar; adicionamos individualmente.
      await Promise.all(
        APP_SHELL.map(async (url) => {
          try {
            const response = await fetch(new Request(url, { cache: 'reload' }));
            if (response && response.ok) await cache.put(url, response);
          } catch (error) {
            // Um recurso indisponivel nao deve impedir a instalacao.
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith('lottery-engine-cache-') && key !== CACHE_NAME).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isCacheable(response) {
  return response && response.ok && response.type === 'basic' && response.status === 200;
}

function isDataRequest(url) {
  return DATA_PATTERN.test(url.pathname);
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) {
    // Revalida em segundo plano sem bloquear a resposta.
    eventRevalidate(cache, request);
    return cached;
  }
  return networkFirst(request, { fallbackToCache: false });
}

async function eventRevalidate(cache, request) {
  try {
    const response = await fetch(request);
    if (isCacheable(response)) await cache.put(request, response.clone());
  } catch (error) {
    /* offline: mantemos o cache */
  }
}

async function networkFirst(request, options = {}) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (options.fallbackToCache !== false) {
      const shell = await cache.match('./index.html', { ignoreSearch: true });
      if (shell) return shell;
    }
    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  // Dataset e sempre o mesmo arquivo: ignoramos querystring ao casar o cache.
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then(async (response) => {
      if (isCacheable(response)) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) return cached;
  const fresh = await network;
  if (fresh) return fresh;
  return new Response(JSON.stringify({ error: 'offline', message: 'dataset indisponivel offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Atualizacao manual de dados: sempre rede (e o botao "Atualizar dados").
  const forceNetwork = url.searchParams.has('v');
  if (isDataRequest(url)) {
    event.respondWith(forceNetwork ? networkFirst(request) : staleWhileRevalidate(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
