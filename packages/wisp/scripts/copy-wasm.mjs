// Copies MediaPipe's WASM runtime from node_modules into public/ so WISP
// loads it from its own origin (no CDN needed at run time).
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const from = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm')
const to = resolve(root, 'public/mediapipe/wasm')
if (!existsSync(from)) {
  console.error('[wisp] @mediapipe/tasks-vision is not installed. Run `npm install` in packages/wisp.')
  process.exit(1)
}
mkdirSync(to, { recursive: true })
cpSync(from, to, { recursive: true })
console.log('[wisp] MediaPipe WASM copied to public/mediapipe/wasm')
