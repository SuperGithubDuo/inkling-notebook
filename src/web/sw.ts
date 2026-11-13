/**
 * Service worker of the web app.
 *
 *  1. Offline: the app's own files are cached when it is installed (the list
 *     is written into this file by the build) and served from the cache.
 *  2. Stored images and PDFs: the page asks for <app>/asset/<notebook>/<file>
 *     and gets the bytes from IndexedDB, the web's counterpart of the desktop
 *     app's inkling-asset:// scheme.
 *
 * Nothing else is intercepted: Supabase and the AI server always go to the network.
 */
interface SwEvent extends Event {
  waitUntil(p: Promise<unknown>): void
}
interface SwFetchEvent extends SwEvent {
  request: Request
  respondWith(r: Response | Promise<Response>): void
}
// The few service-worker globals used here (the DOM typings this project compiles with don't include them).
const sw = self as unknown as {
  location: Location
  skipWaiting(): Promise<void>
  clients: { claim(): Promise<void> }
  addEventListener(type: 'install' | 'activate', listener: (e: SwEvent) => void): void
  addEventListener(type: 'fetch', listener: (e: SwFetchEvent) => void): void
}
/** Replaced at build time. */
declare const __PRECACHE__: string[]
declare const __BUILD_ID__: string

const CACHE = `inkling-${__BUILD_ID__}`
const base = new URL('./', sw.location.href)
const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' }

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(__PRECACHE__.map((path) => new Request(new URL(path, base), { cache: 'reload' }))))
      .then(() => sw.skipWaiting())
  )
})

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('inkling-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim())
  )
})

function readAsset(key: string): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('inkling-assets', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('assets')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const get = db.transaction('assets').objectStore('assets').get(key)
      get.onsuccess = () => (db.close(), resolve(get.result as Uint8Array | undefined))
      get.onerror = () => (db.close(), reject(get.error))
    }
  })
}

async function serveAsset(key: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{6,64}\/[A-Za-z0-9_-]{6,64}\.(png|jpg|jpeg|gif|webp|pdf)$/.test(key)) return new Response('Not found', { status: 404 })
  const bytes = await readAsset(key).catch(() => undefined)
  if (!bytes) return new Response('Not found', { status: 404 })
  return new Response(bytes as BodyInit, {
    headers: {
      'Content-Type': TYPES[key.slice(key.lastIndexOf('.') + 1)] ?? 'application/octet-stream',
      // Stored files are shown as images or read by the PDF renderer, never run as a page.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'no-store'
    }
  })
}

sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== sw.location.origin || !url.pathname.startsWith(base.pathname)) return
  const path = url.pathname.slice(base.pathname.length)
  if (path.startsWith('asset/')) return event.respondWith(serveAsset(path.slice('asset/'.length)))
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      // The app is one page: any navigation inside it is index.html.
      const hit = await cache.match(event.request.mode === 'navigate' ? new URL('index.html', base).href : event.request, { ignoreSearch: event.request.mode === 'navigate' })
      return hit ?? fetch(event.request)
    })()
  )
})
