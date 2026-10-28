/**
 * Image handling for Markdown import/export. Notes reference images through
 * inkling-asset:// URLs; Markdown files on disk reference ordinary paths.
 */
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASSET_SCHEME, assetUrl } from '@shared/ipc'

/** `![alt](target "title")` with an optional <angle-bracketed> target. */
const IMAGE_RE = /(!\[[^\]]*\]\()\s*(<[^>]+>|[^)\s]+)(\s+"[^"]*")?\s*\)/g
const ASSET_URL_RE = new RegExp(`${ASSET_SCHEME}://asset/([A-Za-z0-9_-]{6,64})/([A-Za-z0-9_-]{6,64}\\.(?:png|jpe?g|gif|webp))`, 'g')

const isRemote = (target: string): boolean => /^(https?:|data:|inkling-asset:|mailto:)/i.test(target)

async function replaceAsync(input: string, re: RegExp, fn: (...m: string[]) => Promise<string>): Promise<string> {
  const jobs: Promise<string>[] = []
  input.replace(re, (...m: string[]) => {
    jobs.push(fn(...m))
    return ''
  })
  const out = await Promise.all(jobs)
  let i = 0
  return input.replace(re, () => out[i++]!)
}

/**
 * Copies local images referenced by a Markdown file into the notebook and
 * rewrites their links. Missing or unsupported images are left untouched.
 */
export async function importMarkdownImages(
  markdown: string,
  markdownPath: string,
  notebookId: string,
  store: (bytes: Uint8Array) => Promise<string>
): Promise<string> {
  const base = dirname(markdownPath)
  return replaceAsync(markdown, IMAGE_RE, async (whole, open, rawTarget, title) => {
    const target = rawTarget!.replace(/^<|>$/g, '')
    if (isRemote(target)) return whole!
    try {
      const path = target.startsWith('file:') ? fileURLToPath(target) : isAbsolute(target) ? target : resolve(base, decodeURI(target))
      const asset = await store(new Uint8Array(await fs.readFile(path)))
      return `${open}${assetUrl(notebookId, asset)}${title ?? ''})`
    } catch {
      return whole!
    }
  })
}

/**
 * Writes `markdown` to `path`, copying every referenced Inkling image into a
 * `<name>_assets` folder next to it and pointing the links there.
 */
export async function exportMarkdownWithImages(
  markdown: string,
  path: string,
  readAsset: (notebookId: string, asset: string) => Promise<Uint8Array>
): Promise<void> {
  const folderName = `${basename(path, extname(path))}_assets`
  const folder = join(dirname(path), folderName)
  let made = false
  const body = await replaceAsync(markdown, ASSET_URL_RE, async (_whole, notebookId, asset) => {
    if (!made) {
      await fs.mkdir(folder, { recursive: true })
      made = true
    }
    await fs.writeFile(join(folder, asset!), await readAsset(notebookId!, asset!))
    return `${encodeURI(folderName)}/${asset}`
  })
  await fs.writeFile(path, body, 'utf8')
}
