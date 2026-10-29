import mark from '@/assets/inkling-mark.svg'

/** Inkling's mark (the app icon). */
export function BrandMark({ size = 56 }: { size?: number }) {
  return <img src={mark} width={size} height={size} alt="" draggable={false} className="select-none" />
}
