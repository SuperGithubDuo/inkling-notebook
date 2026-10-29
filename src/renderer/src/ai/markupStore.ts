/**
 * "Show this on my page": the tutor reads an image of the student's work and
 * proposes marks (✓, ✗, circles, corrections, notes). The proposal is shown
 * as a preview on the page; nothing is added until the user approves, and
 * then everything is added as one undoable, editable AI-authored step.
 */
import { create } from 'zustand'
import type { AiError, AiPart } from '@shared/ai'
import type { CanvasObject } from '@shared/schema'
import { parseTaskResult, type AnnotationSet } from '@shared/tutor'
import { useStore } from '@/store/store'
import { notebookContext } from '@/services/notebookContext'
import { buildTransaction, type CanvasCommand } from '@/canvas/commands'
import type { Rect } from '@/canvas/geometry'
import { buildContext, captureRegion, hasSelection, type ImageRegion } from './context'
import { cancelAi, preflight, startAi } from './client'
import { planAnnotations, type PlacedAnnotation } from './annotate'

export interface MarkupProposal {
  pageId: string
  region: Rect
  result: AnnotationSet
  placed: PlacedAnnotation[]
  included: boolean[]
  /** Objects the kept annotations would add, for the on-page preview. */
  preview: CanvasObject[]
}

interface MarkupState {
  status: 'idle' | 'running' | 'ready' | 'applied' | 'error'
  requestId: string | null
  proposal: MarkupProposal | null
  applied: { pageId: string; count: number } | null
  error: AiError | null
  lastRequest: { guidance?: string; region?: ImageRegion } | null
  start(opts?: { guidance?: string; region?: ImageRegion }): Promise<void>
  toggle(index: number): void
  approve(): void
  discard(): void
  cancel(): void
  undoApplied(): void
}

const keptCommands = (p: Pick<MarkupProposal, 'placed' | 'included'>): CanvasCommand[] => p.placed.flatMap((x, i) => (p.included[i] ? x.commands : []))

function previewOf(pageId: string, p: Pick<MarkupProposal, 'placed' | 'included'>): CanvasObject[] {
  const page = useStore.getState().pages[pageId]
  if (!page) return []
  try {
    const { transaction } = buildTransaction(page, keptCommands(p), { author: 'ai' })
    return transaction.ops.flatMap((op) => (op.kind === 'add' ? op.items.map((i) => i.object) : []))
  } catch {
    return []
  }
}

export const useMarkup = create<MarkupState>((set, get) => ({
  status: 'idle',
  requestId: null,
  proposal: null,
  applied: null,
  error: null,
  lastRequest: null,

  async start(opts = {}) {
    if (get().status === 'running') return
    set({ error: null, proposal: null, applied: null, lastRequest: opts })
    const blocked = await preflight()
    if (blocked) return set({ status: 'error', error: blocked })
    set({ status: 'running', requestId: null })
    const fail = (error: AiError): void => set({ status: 'error', error, requestId: null })

    // The work to mark up: the region a chat answer was about, or the selection.
    let image: AiPart | undefined
    let region: ImageRegion | undefined
    try {
      if (opts.region) {
        const captured = await captureRegion(opts.region.pageId, opts.region.rect)
        if (captured) {
          image = { image: { mimeType: captured.image.mimeType, data: captured.image.data } }
          region = captured.region
        }
      } else if (hasSelection()) {
        const ctx = await buildContext('selection')
        image = ctx?.parts.find((p) => 'image' in p)
        region = ctx?.region
      }
    } catch (err) {
      return fail({ code: 'bad_request', message: (err as Error).message })
    }
    if (!image || !region) return fail({ code: 'bad_request', message: 'Select your handwritten work with the lasso first, then ask the tutor to mark it up.' })

    const ask = opts.guidance
      ? `<tutor_explanation>\n${opts.guidance.slice(0, 4000)}\n</tutor_explanation>\nMark up my work in the image so it matches this explanation.`
      : 'Check my work in the image and mark it up.'
    const target = region
    const result = await startAi(
      { task: 'annotate', turns: [{ role: 'user', parts: [{ text: ask }, image] }] },
      {
        onDone: (e) => {
          const parsed = parseTaskResult('annotate', e.text)
          const page = useStore.getState().pages[target.pageId]
          if (!parsed || !page) return fail({ code: 'bad_response', message: 'The tutor’s markup was not in the expected format. Try again.' })
          // Keep only annotations whose commands pass the canvas validation on their own.
          const placed = planAnnotations(parsed.annotations, { region: target.rect, page }).filter((p) => {
            try {
              buildTransaction(page, p.commands, { author: 'ai' })
              return p.commands.length > 0
            } catch {
              return false
            }
          })
          const included = placed.map(() => true)
          set({
            status: 'ready',
            requestId: null,
            proposal: { pageId: target.pageId, region: target.rect, result: parsed, placed, included, preview: previewOf(target.pageId, { placed, included }) }
          })
        },
        onError: (error) => (error.code === 'canceled' ? set({ status: 'idle', requestId: null }) : fail(error))
      }
    )
    if ('error' in result) fail(result.error)
    else if (get().status === 'running') set({ requestId: result.requestId })
  },

  toggle(index) {
    const p = get().proposal
    if (!p) return
    const included = p.included.map((v, i) => (i === index ? !v : v))
    set({ proposal: { ...p, included, preview: previewOf(p.pageId, { placed: p.placed, included }) } })
  },

  approve() {
    const p = get().proposal
    if (!p) return
    const commands = keptCommands(p)
    if (!commands.length) return set({ proposal: null, status: 'idle' })
    const result = notebookContext.applyCanvasCommands(p.pageId, commands, { label: 'AI feedback' })
    if (!result.ok) return set({ status: 'error', error: { code: 'bad_response', message: `Could not add the marks: ${result.error}` } })
    set({ status: 'applied', proposal: null, applied: { pageId: p.pageId, count: p.included.filter(Boolean).length } })
  },

  discard() {
    set({ status: 'idle', proposal: null })
  },

  cancel() {
    const id = get().requestId
    if (id) cancelAi(id)
  },

  undoApplied() {
    const a = get().applied
    const s = useStore.getState()
    if (a && s.activePageId === a.pageId) s.undo()
    set({ status: 'idle', applied: null })
  }
}))
