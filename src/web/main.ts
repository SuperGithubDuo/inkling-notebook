/**
 * Entry point of the web app. Sets up storage, the account and the service
 * worker, installs `window.inkling`, then starts the same renderer the
 * desktop app runs.
 */
import { serveAssetsFrom } from '@shared/ipc'
import { createWebApi } from './api'
import { startSession } from './account'

/** The folder the app is served from, e.g. https://example.org/app/ */
const base = new URL('./', location.href)

/**
 * The service worker makes the app work offline and serves stored images and
 * PDFs. A page it doesn't control yet (first visit, hard reload) can't show
 * those, so wait for it — and reload once if the browser bypassed it.
 */
async function serviceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  try {
    await navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname })
    await navigator.serviceWorker.ready
    if (navigator.serviceWorker.controller) return sessionStorage.removeItem('inkling.swReload')
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
      setTimeout(resolve, 2000)
    })
    if (!navigator.serviceWorker.controller && !sessionStorage.getItem('inkling.swReload')) {
      sessionStorage.setItem('inkling.swReload', '1')
      location.reload()
      await new Promise(() => undefined)
    }
  } catch (err) {
    console.warn('Offline support is unavailable:', (err as Error).message)
  }
}

/**
 * One tab at a time. Two tabs would each save their own copy of the same notebooks over the
 * other's (the desktop app prevents the same with its single-instance lock).
 */
async function onlyTab(): Promise<void> {
  if (!navigator.locks) return
  const held = await new Promise<boolean>((resolve) => {
    void navigator.locks.request('inkling-app', { ifAvailable: true }, (lock) => {
      resolve(!!lock)
      // Held for as long as this tab lives.
      return lock ? new Promise(() => undefined) : undefined
    })
  })
  if (held) return
  document.getElementById('root')!.innerHTML =
    '<div role="alert" style="padding:32px;font:15px system-ui;max-width:32rem;margin:auto"><p><b>Inkling is already open in another tab.</b></p><p>Use that tab, or close it and this one will continue.</p></div>'
  await navigator.locks.request('inkling-app', () => location.reload())
  await new Promise(() => undefined)
}

async function start(): Promise<void> {
  // Ask the browser not to evict notebooks when storage runs low (matters most without an account).
  void navigator.storage?.persist?.().catch(() => undefined)
  await onlyTab()
  serveAssetsFrom(base.pathname)
  const [, session] = await Promise.all([serviceWorker(), startSession(base.href)])
  window.inkling = createWebApi(session)
  // The renderer reads window.inkling as it loads, so it is imported only now.
  await import('../renderer/src/main')
}

start().catch((err: Error) => {
  document.getElementById('root')!.innerHTML = '<div style="padding:32px;font:15px system-ui"><p><b>Inkling couldn’t start.</b></p><p id="why"></p><p>Your notebooks are untouched. Try reloading the page.</p></div>'
  document.getElementById('why')!.textContent = err.message
})
