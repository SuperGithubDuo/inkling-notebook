#!/usr/bin/env node
/**
 * Downloads the Electron runtime after `npm install` / `npm ci`.
 *
 * Why this exists: Electron 45's npm package no longer has a postinstall step.
 * It downloads its binary lazily, the first time something calls
 * `require('electron')`, or on demand via its `install-electron` bin.
 * electron-vite 6 (`npm run dev` / `npm start`) and Playwright's
 * `_electron.launch` don't go through that lazy path: electron-vite reads
 * `node_modules/electron/path.txt` directly and fails with "Electron uninstall"
 * when it is missing. So after a clean `npm ci` nothing ever fetched the binary.
 *
 * This script runs Electron's own installer (`node_modules/electron/install.js`,
 * which verifies the download against Electron's checksums and is a no-op when
 * the right binary is already there).
 *
 * Set ELECTRON_SKIP_BINARY_DOWNLOAD=1 to skip it (CI does this: typecheck, unit
 * tests and the build never launch Electron). A failed download (offline, proxy)
 * only warns, so `npm ci` itself still succeeds; run `npm run electron:install`
 * once the network is available.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const skip = process.env.ELECTRON_SKIP_BINARY_DOWNLOAD
if (skip && skip !== '0' && skip.toLowerCase() !== 'false') {
  console.log('[inkling] ELECTRON_SKIP_BINARY_DOWNLOAD is set; not downloading the Electron runtime.')
  process.exit(0)
}

const require = createRequire(import.meta.url)
let installer
try {
  installer = join(dirname(require.resolve('electron/package.json')), 'install.js')
} catch {
  // `npm ci --omit=dev` (no Electron installed): nothing to do.
  process.exit(0)
}
if (!existsSync(installer)) process.exit(0)

const strict = process.argv.includes('--strict')
const result = spawnSync(process.execPath, [installer], { stdio: 'inherit' })
if (result.status !== 0) {
  const msg =
    '[inkling] Could not download the Electron runtime (see the error above). ' +
    'Check your network or proxy, then run `npm run electron:install`.'
  if (strict) {
    console.error(msg)
    process.exit(result.status ?? 1)
  }
  console.warn(msg)
}
