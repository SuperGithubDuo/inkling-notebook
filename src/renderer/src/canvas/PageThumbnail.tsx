/** Live SVG preview of a page, rendered from the same vector data as the canvas. */
import { memo } from 'react'
import type { CanvasObject, PageDoc } from '@shared/schema'
import { assetUrl } from '@shared/ipc'
import { strokePathData } from './ink'
import { shapeD } from './shapes'
import { FONT_FAMILY, wrapLines } from './text'
import { TEXT_LINE_HEIGHT } from './geometry'
import { PAPER_FILL } from './paper'

function ThumbObject({ o, notebookId }: { o: CanvasObject; notebookId: string }) {
  switch (o.type) {
    case 'stroke':
      return (
        <path
          d={strokePathData(o)}
          fill={o.color}
          fillOpacity={o.opacity}
          style={o.tool === 'highlighter' ? { mixBlendMode: 'multiply' } : undefined}
        />
      )
    case 'text':
      return (
        <text x={o.x} y={o.y} fill={o.color} fontSize={o.fontSize} fontFamily={FONT_FAMILY[o.font]}>
          {wrapLines(o).map((line, i) => (
            <tspan key={i} x={o.x} dy={i === 0 ? o.fontSize : o.fontSize * TEXT_LINE_HEIGHT}>
              {line}
            </tspan>
          ))}
        </text>
      )
    case 'shape':
      return (
        <path
          d={shapeD(o)}
          transform={`translate(${o.x} ${o.y}) rotate(${o.rotation})`}
          stroke={o.color}
          strokeWidth={o.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill={o.fill ?? 'none'}
          fillOpacity={o.fill ? o.fillOpacity : undefined}
        />
      )
    case 'image':
      return (
        <image
          href={assetUrl(notebookId, o.asset)}
          width={o.width}
          height={o.height}
          transform={`translate(${o.x} ${o.y}) rotate(${o.rotation})`}
          preserveAspectRatio="none"
        />
      )
  }
}

export const PageThumbnail = memo(function PageThumbnail({ page }: { page: PageDoc }) {
  const { width: w, height: h, paper } = page
  const pid = `paper-${page.id}`
  const s = paper.spacing
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="block h-full w-full" aria-hidden preserveAspectRatio="xMidYMid meet">
      <defs>
        <pattern id={pid} width={s} height={s} patternUnits="userSpaceOnUse">
          {paper.type === 'grid' && <path d={`M${s} 0V${s}M0 ${s}H${s}`} stroke={paper.color} strokeWidth={2.5} fill="none" />}
          {paper.type === 'lined' && <path d={`M0 ${s}H${s}`} stroke={paper.color} strokeWidth={2.5} />}
          {paper.type === 'dotted' && <circle cx={s / 2} cy={s / 2} r={2.5} fill={paper.color} />}
        </pattern>
        <clipPath id={`clip-${page.id}`}>
          <rect width={w} height={h} />
        </clipPath>
      </defs>
      <rect width={w} height={h} fill={PAPER_FILL} />
      {paper.type !== 'blank' && <rect width={w} height={h} fill={`url(#${pid})`} />}
      <g clipPath={`url(#clip-${page.id})`}>
        {page.objects.map((o) => (
          <ThumbObject key={o.id} o={o} notebookId={page.notebookId} />
        ))}
      </g>
    </svg>
  )
})
