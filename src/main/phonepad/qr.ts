/**
 * QR code for the pairing URL, as one SVG path. Generated in the main process
 * so the renderer only draws a path (no HTML, no images, CSP unchanged).
 */
import qrcode from 'qrcode-generator'

export function qrPath(text: string): { size: number; path: string } {
  // Level M survives a glare spot or a slightly blurry phone camera.
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const size = qr.getModuleCount()
  let path = ''
  for (let r = 0; r < size; r++) {
    let c = 0
    while (c < size) {
      if (!qr.isDark(r, c)) {
        c++
        continue
      }
      // Merge each horizontal run of dark modules into one rectangle.
      const start = c
      while (c < size && qr.isDark(r, c)) c++
      path += `M${start} ${r}h${c - start}v1h${start - c}z`
    }
  }
  return { size, path }
}
