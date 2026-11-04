/**
 * Which Workers AI model answers a request. One narrow rule, OFF unless the
 * operator sets MODEL_TEXT (wrangler var):
 *
 *   - anything that involves handwriting goes to the main model (MODEL, Qwen 3.8 27B),
 *     exactly as before;
 *   - a request with no handwriting context at all, for a task listed in
 *     TEXT_MODEL_TASKS (default: practice generation only), may go
 *     to the text model (MODEL_TEXT, e.g. Gemma 4 26B A4B), with thinking off.
 *
 * "Handwriting context" is decided conservatively, from the request alone:
 *   - any image part in any turn (the current question or an earlier one);
 *   - the app's "(image omitted)" placeholder, which stands in for an earlier
 *     image it dropped (src/renderer/src/ai/turns.ts);
 *   - a conversation at the app's history limit (HISTORY_ENTRIES / 2 earlier
 *     exchanges): older exchanges may have been cut, and with them an image the
 *     follow-up still refers to;
 *   - the markup task, which always reads handwriting.
 *
 * So a follow-up about a page always stays on the model that read the page.
 * There is no fallback between the two: a failure is reported as before and
 * never retried on the other model. Both models are Cloudflare Workers AI, so
 * the data notice ("answered by Cloudflare Workers AI") is unchanged.
 */
import type { AiRequest, AiTurn } from '../../src/shared/ai'
import { HISTORY_ENTRIES } from '../../src/renderer/src/ai/turns'
import type { Rates } from './upstream'

/** What the app sends in place of an earlier image it left out. */
export const IMAGE_OMITTED = '(image omitted)'

export interface ModelChoice {
  /** 'main': the main model (everything with handwriting context, and every task not listed); 'text': the text-only model. */
  route: 'main' | 'text'
  model: string
  rates: Rates
  reasoningEffort: string
  disableThinking: boolean
}

/** Tasks the text model may answer. Markup ('annotate') never: it always reads handwriting. */
export type TextTask = 'chat' | 'practice' | 'check'
/**
 * Default when MODEL_TEXT is set without TEXT_MODEL_TASKS: practice generation only. In the live
 * evaluation (4 Nov 2026) Gemma told a student with a correct answer (11/15) to "take a second
 * look", so anything that judges a student's answer (chat, answer checks) stays on the main model.
 */
export const DEFAULT_TEXT_TASKS: readonly TextTask[] = ['practice']

export interface TextModelConfig {
  model: string
  rates: Rates
  /** Which tasks it may answer (default DEFAULT_TEXT_TASKS). */
  tasks?: readonly TextTask[]
}

/** True when the request depends on handwriting the text model can't be trusted to read. */
export function needsMainModel(task: AiRequest['task'], turns: AiTurn[]): boolean {
  if (task === 'annotate') return true
  for (const t of turns) for (const p of t.parts) if ('image' in p || ('text' in p && p.text.trim() === IMAGE_OMITTED)) return true
  // turns = earlier exchanges (user + model each) + the current question.
  const earlierExchanges = Math.floor((turns.length - 1) / 2)
  return earlierExchanges >= HISTORY_ENTRIES / 2
}

export function chooseModel(
  task: AiRequest['task'],
  turns: AiTurn[],
  main: { model: string; rates: Rates; reasoningEffort: string; disableThinking: boolean },
  text?: TextModelConfig | null
): ModelChoice {
  const tasks: readonly string[] = text?.tasks ?? DEFAULT_TEXT_TASKS
  if (!text || !tasks.includes(task) || needsMainModel(task, turns)) return { route: 'main', ...main }
  // Thinking off and no reasoning effort: the settings the benchmark measured (docs/benchmarks/).
  return { route: 'text', model: text.model, rates: text.rates, reasoningEffort: '', disableThinking: true }
}

/**
 * The text model from the Worker's settings, or null (the rule is off). Off unless
 * MODEL_TEXT names a Workers AI model and both its prices are positive numbers.
 */
export function textModelFrom(env: { MODEL_TEXT?: string; TEXT_INPUT_NEURONS_PER_M?: string; TEXT_OUTPUT_NEURONS_PER_M?: string; TEXT_MODEL_TASKS?: string }, mainModel: string): TextModelConfig | null {
  const model = (env.MODEL_TEXT ?? '').trim()
  if (!model || model === mainModel || !/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(model)) return null
  const inputPerM = Number(env.TEXT_INPUT_NEURONS_PER_M)
  const outputPerM = Number(env.TEXT_OUTPUT_NEURONS_PER_M)
  if (!(Number.isFinite(inputPerM) && inputPerM > 0 && Number.isFinite(outputPerM) && outputPerM > 0)) return null
  // TEXT_MODEL_TASKS: a comma-separated subset of chat, practice, check; unknown names are ignored.
  const named = (env.TEXT_MODEL_TASKS ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t): t is TextTask => t === 'chat' || t === 'practice' || t === 'check')
  return { model, rates: { inputPerM, outputPerM }, tasks: named.length ? [...new Set(named)] : DEFAULT_TEXT_TASKS }
}
