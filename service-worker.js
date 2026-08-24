/* Service worker - precaches the whole application shell (the page, its styles,
 * every JavaScript module the page loads, the settings files, the pdf.js worker
 * and the icons) so the app opens instantly and works fully offline. It holds
 * NO financial data: every transaction lives in the browser database, never in
 * this cache.
 *
 * Two update behaviours, on purpose:
 *   CODE (the page and its scripts) uses network-first, so an edit appears
 *   immediately when a server is reachable, and the cached copy is only used
 *   when offline.
 *   STATIC ASSETS (the pdf.js worker, icons, manifest) use cache-first, for
 *   instant, offline-safe loads.
 *
 * The install step fetches every shell file with cache-busting, so bumping
 * VERSION always fills the new cache with genuinely fresh bytes rather than a
 * stale copy from the browser's own HTTP cache.
 *
 * IMPORTANT - scope. This worker is served from the repository root, the same
 * folder as index.html, so its default scope already covers the whole app:
 * the page itself, and the sibling interface/, application/, settings/ and
 * third-party/ folders. Every precache path below is written relative to this
 * root location.
 */

const VERSION = 'personalfinanceja-v1.2';

// CODE: the page and every module it loads. Kept as one list so isCode() below
// can recognise them and serve them network-first. These are the exact paths
// the browser requests, matching the import statements in index.html and app.js.
const CODE = [
  './',
  './index.html',
  './interface/styles.css',
  './application/app.js',
  './application/shared-helpers.js',
  './application/read-statements.js',
  './application/categorise.js',
  './application/storage.js',
  './application/reporting.js',
  './application/accounts-render.js',
  './application/category-picker.js',
  './application/manage-data.js',
  './application/data-export.js',
  './application/cards-render.js',
  './settings/category-rules.js',
  './settings/merchant-intelligence.js',
  './settings/config.json',
  './settings/jamaica-merchants.json',
];

// STATIC ASSETS: served cache-first. Every icon the manifest and the page
// reference is listed so an installed app has all of them offline.
const ASSETS = [
  './favicon.ico',
  './interface/manifest.json',
  './interface/icons/icon-192.png',
  './interface/icons/icon-512.png',
  './interface/icons/icon-maskable-512.png',
  './interface/icons/apple-touch-icon.png',
  './third-party/pdf.min.mjs',
  './third-party/pdf.worker.min.mjs',
];

const SHELL = CODE.concat(ASSETS);

// Resolve every CODE path to a full URL once, so matching a request is a simple
// exact-URL check. The previous version compared '.' + url.pathname against the
// stored '../application/...' strings, which could never match; this fixes that.
const CODE_URLS = new Set(CODE.map((p) => new URL(p, self.location).href));

// True for requests that should be treated as code: any page navigation, or any
// request whose resolved URL is one of the CODE entries above.
function isCode(req, url) {
  if (req.mode === 'navigate') return true;
  return CODE_URLS.has(url.href);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res && res.ok) await cache.put(url, res.clone());
        else console.warn(`Service worker: precache skipped for ${url} (HTTP ${res ? res.status : 'no response'}).`);
      } catch (err) { console.warn(`Service worker: precache failed for ${url}.`, err); }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);

    if (isCode(req, url)) {
      // Network-first for code: show edits immediately when online, fall back
      // to the cached copy when offline. A navigation with no network and no
      // cached page falls back to the cached index.html so the app still opens.
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) { await cache.put(req, fresh.clone()); return fresh; }
        const cached = await cache.match(req);
        if (cached) return cached;
        if (req.mode === 'navigate') {
          const shell = await cache.match('./index.html');
          if (shell) return shell;
        }
        return fresh; // let the real (non-ok) response through if nothing cached
      } catch {
        const cached = await cache.match(req);
        if (cached) return cached;
        if (req.mode === 'navigate') {
          const shell = await cache.match('./index.html');
          if (shell) return shell;
        }
        return new Response('Offline and this resource is not cached.', {
          status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/plain' },
        });
      }
    }

    // Cache-first for static assets: instant and offline-safe. On a miss, fetch
    // once and store it for next time.
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) await cache.put(req, fresh.clone());
      return fresh;
    } catch {
      return new Response('Offline and this asset is not cached.', {
        status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/plain' },
      });
    }
  })());
});
