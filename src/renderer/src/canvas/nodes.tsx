/** Konva nodes for each object type. All draw from the page model; none own state. */
import { memo, type Ref } from 'react'
import { Image as KImage, Shape, Text } from 'react-konva'
import type Konva from 'konva'
import type { CanvasObject, ImageObject, ShapeObject, StrokeObject, TextObject } from '@shared/schema'
import { strokePath2D } from './ink'
import { paintShape, shapePath2D } from './shapes'
import { useAsset } from './assets'
import { FONT_FAMILY } from './text'
import { TEXT_LINE_HEIGHT } from './geometry'

export const StrokeNode = memo(function StrokeNode({ stroke }: { stroke: StrokeObject }) {
  return (
    <Shape
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(ctx) => {
        const c = ctx._context
        c.save()
        c.globalAlpha = stroke.opacity
        // Multiply keeps ink beneath a highlight fully legible.
        if (stroke.tool === 'highlighter') c.globalCompositeOperation = 'multiply'
        c.fillStyle = stroke.color
        c.fill(strokePath2D(stroke))
        c.restore()
      }}
    />
  )
})

export const TextNode = memo(function TextNode({ text }: { text: TextObject }) {
  return (
    <Text
      listening={false}
      x={text.x}
      y={text.y}
      width={text.width}
      text={text.text}
      fill={text.color}
      fontSize={text.fontSize}
      fontFamily={FONT_FAMILY[text.font]}
      lineHeight={TEXT_LINE_HEIGHT}
      wrap="word"
    />
  )
})

interface Interactive {
  nodeRef?: Ref<Konva.Shape | Konva.Image>
  /** Selected on its own: draggable and transformable in place. */
  editable?: boolean
  onDragEnd?: () => void
}

export const ShapeNode = memo(function ShapeNode({ shape, nodeRef, editable, onDragEnd }: { shape: ShapeObject } & Interactive) {
  return (
    <Shape
      ref={nodeRef as Ref<Konva.Shape>}
      listening={!!editable}
      draggable={!!editable}
      onDragEnd={onDragEnd}
      perfectDrawEnabled={false}
      x={shape.x}
      y={shape.y}
      width={shape.width}
      height={shape.height}
      rotation={shape.rotation}
      sceneFunc={(ctx) => {
        const c = ctx._context
        c.save()
        paintShape(c, shapePath2D(shape), shape)
        c.restore()
      }}
      hitFunc={(ctx, node) => {
        ctx.beginPath()
        ctx.rect(0, 0, shape.width, shape.height)
        ctx.closePath()
        ctx.fillStrokeShape(node)
      }}
    />
  )
})

export const ImageNode = memo(function ImageNode({
  image,
  notebookId,
  nodeRef,
  editable,
  onDragEnd
}: { image: ImageObject; notebookId: string } & Interactive) {
  const el = useAsset(notebookId, image.asset)
  return (
    <KImage
      ref={nodeRef as Ref<Konva.Image>}
      image={el ?? undefined}
      listening={!!editable}
      draggable={!!editable}
      onDragEnd={onDragEnd}
      x={image.x}
      y={image.y}
      width={image.width}
      height={image.height}
      rotation={image.rotation}
      // A soft placeholder while the file loads.
      fill={el ? undefined : '#eef0f4'}
      perfectDrawEnabled={false}
    />
  )
})

export function ObjectNode({ object, notebookId }: { object: CanvasObject; notebookId: string }) {
  switch (object.type) {
    case 'stroke':
      return <StrokeNode stroke={object} />
    case 'text':
      return <TextNode text={object} />
    case 'shape':
      return <ShapeNode shape={object} />
    case 'image':
      return <ImageNode image={object} notebookId={notebookId} />
  }
}
