/** Loads stored image assets once and shares the decoded element. */
import { useEffect, useState } from 'react'
import { assetUrl } from '@shared/ipc'

const cache = new Map<string, Promise<HTMLImageElement>>()

export function loadAsset(notebookId: string, asset: string): Promise<HTMLImageElement> {
  const url = assetUrl(notebookId, asset)
  let p = cache.get(url)
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image()
      // CORS-clean so pages with images can still be exported as PNG.
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(img)
      img.onerror = () => {
        cache.delete(url)
        reject(new Error(`Could not load image ${asset}`))
      }
      img.src = url
    })
    cache.set(url, p)
  }
  return p
}

export function useAsset(notebookId: string, asset: string): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  useEffect(() => {
    let live = true
    loadAsset(notebookId, asset).then(
      (el) => live && setImg(el),
      () => live && setImg(null)
    )
    return () => {
      live = false
    }
  }, [notebookId, asset])
  return img
}

/** Reads natural dimensions of a freshly stored asset. */
export async function assetSize(notebookId: string, asset: string): Promise<{ width: number; height: number }> {
  const img = await loadAsset(notebookId, asset)
  return { width: img.naturalWidth, height: img.naturalHeight }
}
