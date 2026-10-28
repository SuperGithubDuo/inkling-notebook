/**
 * Preview of the tutor's proposed marks, drawn over the page (inside the
 * canvas world group) until the user adds or discards them.
 */
import { Group, Rect } from 'react-konva'
import { ObjectNode } from '@/canvas/nodes'
import { useMarkup } from './markupStore'
import { PREVIEW_NAME } from '@/canvas/stageRef'

export function MarkupPreview({ pageId, notebookId, scale }: { pageId: string; notebookId: string; scale: number }) {
  const proposal = useMarkup((s) => (s.status === 'ready' && s.proposal?.pageId === pageId ? s.proposal : null))
  if (!proposal) return null
  const { region, preview } = proposal
  return (
    <Group listening={false} name={PREVIEW_NAME}>
      <Rect x={region.x} y={region.y} width={region.width} height={region.height} stroke="#6d63f0" strokeWidth={1.5 / scale} dash={[6 / scale, 5 / scale]} cornerRadius={6} fill="rgba(109,99,240,0.04)" />
      <Group opacity={0.9}>
        {preview.map((o) => (
          <ObjectNode key={o.id} object={o} notebookId={notebookId} />
        ))}
      </Group>
    </Group>
  )
}
