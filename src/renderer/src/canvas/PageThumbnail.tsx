/** Live SVG preview of a page, rendered from the same vector data as the canvas. */
import { memo } from 'react'
import type { PageDoc } from '@shared/schema'
import { strokePathData } from './ink'
import { FONT_FAMILY, wrapLines } from './text'
import { TEXT_LINE_HEIGHT } from './geometry'
import { PAPER_FILL } from './paper'

export const PageThumbnail = memo(function PageThumbnail({ page }: { page: PageDoc }) {
  const { width: w, height: h, paper } = page
  const pid = `paper-${page.id}`
  const s = paper.spacing
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="block h-full w-full" aria-hidden preserveAspectRatio="xMidYMin slice">
      <defs>
        <pattern id={pid} width={s} height={s} patternUnits="userSpaceOnUse">
          {paper.type === 'grid' && <path d={`M${s} 0V${s}M0 ${s}H${s}`} stroke={paper.color} strokeWidth={2.5} fill="none" />}
          {paper.type === 'lined' && <path d={`M0 ${s}H${s}`} stroke={paper.color} strokeWidth={2.5} />}
          {paper.type === 'dotted' && <circle cx={s / 2} cy={s / 2} r={2.5} fill={paper.color} />}
        </pattern>
      </defs>
      <rect width={w} height={h} fill={PAPER_FILL} />
      {paper.type !== 'blank' && <rect width={w} height={h} fill={`url(#${pid})`} />}
      {page.objects.map((o) =>
        o.type === 'stroke' ? (
          <path
            key={o.id}
            d={strokePathData(o)}
            fill={o.color}
            fillOpacity={o.opacity}
            style={o.tool === 'highlighter' ? { mixBlendMode: 'multiply' } : undefined}
          />
        ) : (
          <text key={o.id} x={o.x} y={o.y} fill={o.color} fontSize={o.fontSize} fontFamily={FONT_FAMILY[o.font]}>
            {wrapLines(o).map((line, i) => (
              <tspan key={i} x={o.x} dy={i === 0 ? o.fontSize : o.fontSize * TEXT_LINE_HEIGHT}>
                {line}
              </tspan>
            ))}
          </text>
        )
      )}
    </svg>
  )
})
