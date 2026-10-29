/**
 * pdf.js resource folders (standard fonts, cmaps, ...) for tests that run
 * pdf.js under Node.
 *
 * pdf.js has two requirements that a plain `path.join(...)` breaks on Windows:
 *  1. `getDocument` rejects a `standardFontDataUrl` / `cMapUrl` that doesn't end
 *     in "/" ("Invalid factory url: ... must include trailing slash"), and
 *     `path.join` on Windows produces a trailing "\".
 *  2. Its Node loader builds `${base}${fileName}` and hands that string straight
 *     to `fs.readFile`, which treats strings as paths, not URLs, so a
 *     `file:///...` URL string would fail on every platform.
 *
 * So the value must be an absolute filesystem path written with "/"
 * separators and a trailing "/". Node's fs accepts that form on Windows
 * (`C:/Users/.../standard_fonts/`), Linux and macOS alike.
 */
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'

const require = createRequire(import.meta.url)
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'))

/**
 * @param {'standard_fonts' | 'cmaps' | 'wasm' | 'iccs'} name
 * @returns {string} e.g. `C:/repo/node_modules/pdfjs-dist/standard_fonts/`
 */
export function pdfjsDataDir(name) {
  return join(pdfjsRoot, name).split(sep).join('/') + '/'
}
