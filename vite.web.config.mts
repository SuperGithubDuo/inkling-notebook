/**
 * Build of the web app (npm run build:web → out/web): the renderer the
 * desktop app uses, started by src/web/main.ts with the browser platform.
 *
 * Settings (all public; none is a secret):
 *   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY   accounts and sync; without them the app works signed-out only
 *   VITE_INKLING_BETA_URL                       Inkling's cloud AI server; without it the tutor is unavailable
 */
import { cpSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { build as esbuild } from 'esbuild'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = import.meta.dirname
// INKLING_WEB_OUT: a separate output folder for the acceptance tests' build.
const outDir = resolve(root, process.env.INKLING_WEB_OUT ?? 'out/web')
const version = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }).version
const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const PDFJS_DIRS = ['standard_fonts', 'cmaps', 'wasm', 'iccs']

const origin = (url: string | undefined): string | null => {
  try {
    return url ? new URL(url).origin : null
  } catch {
    return null
  }
}

async function serviceWorker(precache: string[], buildId: string): Promise<string> {
  const result = await esbuild({
    entryPoints: [resolve(root, 'src/web/sw.ts')],
    bundle: true,
    write: false,
    minify: true,
    format: 'iife',
    target: 'es2022',
    define: { __PRECACHE__: JSON.stringify(precache), __BUILD_ID__: JSON.stringify(buildId) }
  })
  return result.outputFiles[0]!.text
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

function inklingWeb(env: Record<string, string>): Plugin {
  const supabase = origin(env.VITE_SUPABASE_URL)
  const connect = [supabase, supabase?.replace(/^http/, 'ws'), origin(env.VITE_INKLING_BETA_URL)].filter(Boolean)
  return {
    name: 'inkling-web',
    transformIndexHtml: (html, ctx) => html.replace('%INKLING_CONNECT_SRC%', [...connect, ...(ctx.server ? ['ws://localhost:*', 'http://127.0.0.1:*'] : [])].join(' ')),
    // Development: the service worker and pdf.js's runtime files, served without a build.
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '').split('?')[0]!
        if (path === '/sw.js') {
          res.setHeader('Content-Type', 'text/javascript')
          return res.end(await serviceWorker([], 'dev'))
        }
        const m = /^\/pdfjs\/(standard_fonts|cmaps|wasm|iccs)\/([A-Za-z0-9_.-]+)$/.exec(path)
        if (!m) return next()
        try {
          res.end(readFileSync(join(pdfjsRoot, m[1]!, m[2]!)))
        } catch {
          next()
        }
      })
    },
    // Build: pdf.js's fonts, CMaps and decoders (the web's inkling-asset://pdfjs/), then the
    // service worker with the list of every file to keep for offline use.
    async closeBundle() {
      for (const dir of PDFJS_DIRS) cpSync(join(pdfjsRoot, dir), join(outDir, 'pdfjs', dir), { recursive: true })
      const files = walk(outDir)
        .map((f) => relative(outDir, f).split('\\').join('/'))
        .filter((f) => f !== 'sw.js' && !f.endsWith('.map') && !f.endsWith('.LICENSE'))
      writeFileSync(join(outDir, 'sw.js'), await serviceWorker(files, `${version}-${Date.now().toString(36)}`))
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, 'VITE_')
  return {
    root: resolve(root, 'src/web'),
    envDir: root,
    // Relative, so the same build runs at any path (GitHub Pages serves it under /<repository>/app/).
    base: './',
    resolve: { alias: { '@shared': resolve(root, 'src/shared'), '@': resolve(root, 'src/renderer/src') } },
    define: { __APP_VERSION__: JSON.stringify(version) },
    plugins: [react(), tailwindcss(), inklingWeb(env)],
    build: { outDir, emptyOutDir: true, target: 'es2022', sourcemap: false },
    server: { port: 5174, strictPort: true },
    preview: { port: 5174, strictPort: true }
  }
})
