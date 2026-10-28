/**
 * Structured answers the tutor asks Gemini for. The main process validates a
 * response against these before handing it to the renderer, and the renderer
 * validates again before anything reaches the page.
 */
import { z } from 'zod'
import type { AiTask } from './ai'

const shortText = (max: number) => z.string().trim().min(1).max(max)

// ----------------------------------------------------------------- practice

export const difficultySchema = z.enum(['easy', 'medium', 'hard'])
export type Difficulty = z.infer<typeof difficultySchema>

export const practiceProblemSchema = z.object({
  question: shortText(1500),
  difficulty: difficultySchema,
  /** Progressive hints: each reveals a little more, none gives the answer. */
  hints: z.array(shortText(600)).min(1).max(4),
  answer: shortText(400),
  solution: shortText(4000)
})
export type PracticeProblem = z.infer<typeof practiceProblemSchema>
export const practiceSetSchema = z.object({
  topic: shortText(160),
  problems: z.array(practiceProblemSchema).min(1).max(6)
})
export type PracticeSet = z.infer<typeof practiceSetSchema>

// -------------------------------------------------------------------- check

export const checkResultSchema = z.object({
  verdict: z.enum(['correct', 'partially_correct', 'incorrect', 'unreadable']),
  /** What the model read from the student's answer. */
  transcription: z.string().max(1000),
  feedback: shortText(2000)
})
export type CheckResult = z.infer<typeof checkResultSchema>

// ----------------------------------------------------------------- annotate

/** Gemini's box convention: [ymin, xmin, ymax, xmax], each 0–1000 of the image. */
export const box2dSchema = z
  .array(z.number().min(0).max(1000))
  .length(4)
  .refine(([ymin, xmin, ymax, xmax]) => ymax! >= ymin! && xmax! >= xmin!, 'Box corners are out of order')

export const annotationKindSchema = z.enum(['note', 'correction', 'check', 'cross', 'circle', 'underline', 'arrow'])
export type AnnotationKind = z.infer<typeof annotationKindSchema>

export const annotationSchema = z.object({
  kind: annotationKindSchema,
  /** The part of the student's work this refers to. */
  box_2d: box2dSchema,
  /** Short text for notes and corrections (plain text, Unicode math). */
  text: z.string().trim().max(240).optional()
})
export type Annotation = z.infer<typeof annotationSchema>

export const annotationSetSchema = z.object({
  transcription: z.string().max(2000),
  summary: shortText(600),
  annotations: z.array(annotationSchema).max(8)
})
export type AnnotationSet = z.infer<typeof annotationSetSchema>

/** Result schema per structured task (chat answers are free Markdown). */
export const TASK_RESULT_SCHEMAS = {
  practice: practiceSetSchema,
  check: checkResultSchema,
  annotate: annotationSetSchema
} as const satisfies Partial<Record<AiTask, z.ZodType>>

/** Parses and validates a structured answer; null if it does not fit. */
export function parseTaskResult<T extends keyof typeof TASK_RESULT_SCHEMAS>(task: T, text: string): z.infer<(typeof TASK_RESULT_SCHEMAS)[T]> | null {
  let json: unknown
  try {
    json = JSON.parse(stripFence(text))
  } catch {
    return null
  }
  const parsed = TASK_RESULT_SCHEMAS[task].safeParse(json)
  return parsed.success ? (parsed.data as never) : null
}

const stripFence = (s: string): string => s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
