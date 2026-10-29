/**
 * Path to the Electron executable for Playwright's `_electron.launch`.
 *
 * Resolved through the `electron` package itself rather than a hard-coded
 * `node_modules/electron/dist/electron`, so it is `electron.exe` on Windows and
 * `Electron.app/Contents/MacOS/Electron` on macOS. Requiring `electron` also
 * downloads the binary if it is missing (Electron 45+ downloads lazily).
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** @type {string} */
export const electronPath = require('electron')
