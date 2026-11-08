// Downloads the MediaPipe Hand Landmarker model once, so WISP works offline.
// Without it, WISP falls back to loading the same file from Google's model
// storage the first time webcam mode starts.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const URL_ =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'public/models/hand_landmarker.task')

if (existsSync(out) && !process.argv.includes('--force')) {
  console.log('[wisp] Model already present:', out)
  process.exit(0)
}
mkdirSync(dirname(out), { recursive: true })
const res = await fetch(URL_)
if (!res.ok) {
  console.error(`[wisp] Download failed: HTTP ${res.status}`)
  process.exit(1)
}
const buf = Buffer.from(await res.arrayBuffer())
writeFileSync(out, buf)
console.log(`[wisp] Saved hand_landmarker.task (${(buf.length / 1e6).toFixed(1)} MB)`)
