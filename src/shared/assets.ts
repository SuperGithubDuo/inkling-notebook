/** Checks on image and PDF files, shared by the desktop's file storage and the web's. */
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024
export const MAX_PDF_BYTES = 200 * 1024 * 1024

/** True if the bytes are a PDF file (by signature, not extension). */
export function isPdf(bytes: Uint8Array): boolean {
  // The header may follow a few bytes of junk; PDF readers search the first 1 KB.
  const head = String.fromCharCode(...bytes.subarray(0, 1024))
  return head.includes('%PDF-')
}

/** Identifies an image by its leading bytes; we never trust file extensions. */
export function sniffImage(bytes: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' | null {
  const at = (i: number): number => bytes[i] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'gif'
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to))
  if (bytes.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  return null
}

export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf'
}

/** Checks the bytes are what they claim and returns the file extension to store them under. */
export function assetKind(bytes: Uint8Array, type: 'image' | 'pdf'): string {
  if (type === 'pdf') {
    if (bytes.byteLength > MAX_PDF_BYTES) throw new Error('PDF is larger than 200 MB.')
    if (!isPdf(bytes)) throw new Error('This file is not a PDF.')
    return 'pdf'
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Image is larger than 30 MB.')
  const kind = sniffImage(bytes)
  if (!kind) throw new Error('Unsupported image format. Use PNG, JPEG, GIF or WebP.')
  return kind
}
