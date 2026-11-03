/**
 * A bare Electron window (Chromium) for testing the download page, without the Inkling app.
 * tests/e2e/site.e2e.mjs launches this with Playwright and drives the window.
 */
const { app, BrowserWindow } = require('electron')

app.on('window-all-closed', () => {})
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 900 })
  void win.loadURL('about:blank')
})
