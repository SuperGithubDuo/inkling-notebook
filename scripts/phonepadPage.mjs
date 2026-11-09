/**
 * Builds the PhonePad phone page: bundles src/phonepad/client/main.ts with
 * esbuild and inlines it and the stylesheet into page.html, giving one
 * self-contained HTML string. The main process imports it as
 * `virtual:phonepad-page` and serves it; the server derives CSP hashes from
 * the inline script and style.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const VIRTUAL = 'virtual:phonepad-page'

/** `root` is the project folder (passed in: this file may be bundled into the Vite config). */
export async function buildPhonePadPage(root = resolve(import.meta.dirname, '..')) {
  const dir = resolve(root, 'src/phonepad/client')
  const result = await build({
    entryPoints: [resolve(dir, 'main.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    minify: true,
    // iOS 15 Safari and Chrome on Android from 2021 on.
    target: ['safari15', 'chrome96', 'firefox100'],
    legalComments: 'none',
    metafile: true
  })
  // Never end the inline <script> early.
  const js = result.outputFiles[0].text.replace(/<\/(script)/gi, '<\\/$1').trim()
  const css = (await readFile(resolve(dir, 'page.css'), 'utf8')).replace(/<\/(style)/gi, '').trim()
  const template = await readFile(resolve(dir, 'page.html'), 'utf8')
  const html = template.replace('<style>/*STYLE*/</style>', () => `<style>${css}</style>`).replace('<script>/*SCRIPT*/</script>', () => `<script>${js}</script>`)
  const inputs = Object.keys(result.metafile.inputs).map((p) => resolve(p))
  return { html, inputs: [...inputs, resolve(dir, 'page.css'), resolve(dir, 'page.html')] }
}

/** Vite plugin: `import page from 'virtual:phonepad-page'` gives the HTML string. */
export function phonepadPagePlugin(root) {
  return {
    name: 'inkling-phonepad-page',
    resolveId(id) {
      return id === VIRTUAL ? '\0' + VIRTUAL : null
    },
    async load(id) {
      if (id !== '\0' + VIRTUAL) return null
      const { html, inputs } = await buildPhonePadPage(root)
      for (const file of inputs) this.addWatchFile(file)
      return `export default ${JSON.stringify(html)}`
    }
  }
}
