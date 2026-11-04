/**
 * Consent before any cloud contact (beta readiness audit, 2 Nov 2026: B1 and B2).
 *
 * - No request of any kind (status, model list, connection check, answer) reaches
 *   Inkling's AI server or Google before the user agrees to that provider's notice.
 * - Declining sends nothing; withdrawing stops everything again.
 * - Switching provider never grants consent for another one.
 * - Agreement to an older notice no longer counts, and settings are kept.
 * - The notice lists what is actually sent, and changes to it raise its version.
 *
 * The servers here are the real beta-server code (tests/support/fakeBeta.mjs) and a
 * fake Gemini API; each records every HTTP request it receives.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AiConfig, type SecretCipher } from '../../src/main/ai/config'
import { AiService } from '../../src/main/ai/service'
import { GeminiProvider } from '../../src/main/ai/gemini'
import { OllamaProvider } from '../../src/main/ai/ollama'
import { startBetaServer, type BetaServer } from '../support/fakeBeta.mjs'
import { VALID_KEY, startFakeGemini, type FakeGemini } from '../support/fakeGemini.mjs'
import { buildTurns, HISTORY_ENTRIES, historyFor, type ThreadEntry } from '../../src/renderer/src/ai/turns'
import {
  CLOUD_CONSENT_VERSION,
  CLOUD_DATA_NOTE,
  CLOUD_PERMISSION_SCOPE,
  CLOUD_SENT,
  CLOUD_WHEN_SENT,
  CONSENT_VERSION,
  GEMINI_SENT,
  type AiEvent,
  type AiRequest
} from '../../src/shared/ai'

const cipher: SecretCipher = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (s: string) => Buffer.from(s.split('').reverse().join('')),
  decryptStringAsync: async (b: Buffer) => ({ result: b.toString().split('').reverse().join(''), shouldReEncrypt: false })
}

const IMAGE = Buffer.from('fake jpeg bytes for the request shape').toString('base64')
const requests: Record<'chat' | 'annotate' | 'practice' | 'check', AiRequest> = {
  chat: { task: 'chat', turns: [{ role: 'user', parts: [{ text: '<selection>\nThe attached image shows the part of my page I selected.\n</selection>' }, { image: { mimeType: 'image/jpeg', data: IMAGE } }, { text: 'Check my work.' }] }] },
  annotate: { task: 'annotate', turns: [{ role: 'user', parts: [{ text: 'Check my work in the image and mark it up.' }, { image: { mimeType: 'image/jpeg', data: IMAGE } }] }] },
  practice: { task: 'practice', turns: [{ role: 'user', parts: [{ text: 'Create 2 practice problems at easy difficulty on: fractions.' }] }] },
  check: { task: 'check', turns: [{ role: 'user', parts: [{ text: 'Practice problem:\n1/2 + 1/4\n\nExpected final answer: 3/4' }, { text: 'Student answer (typed): 3/4' }] }] }
}

let gemini: FakeGemini
beforeAll(async () => {
  gemini = await startFakeGemini()
})
afterAll(async () => gemini?.close?.())

describe('no cloud contact before consent', () => {
  let server: BetaServer
  let dir: string
  const events: AiEvent[] = []

  const makeService = async (opts: { provider?: 'cloud' | 'gemini' | 'ollama' } = {}): Promise<{ service: AiService; config: AiConfig }> => {
    const config = new AiConfig(dir, cipher, { builtInCloudUrl: server.url, defaultProvider: 'cloud' })
    await config.load()
    if (opts.provider && opts.provider !== config.provider) await config.setProvider(opts.provider)
    const service = new AiService({
      config,
      makeProvider: (apiKey) => new GeminiProvider({ apiKey, baseUrl: gemini.url }),
      makeLocalProvider: () => new OllamaProvider({ baseUrl: 'http://127.0.0.1:9' }),
      emit: (e) => events.push(e),
      limits: { duplicateWindowMs: 0, minIntervalMs: 0, perMinute: 100 }
    })
    return { service, config }
  }

  /** Every way the app can reach a cloud provider, as the renderer would call them. */
  const tryEverything = async (service: AiService): Promise<void> => {
    await service.freshStatus()
    service.status()
    expect(await service.refreshModels()).toMatchObject({ ok: false, error: { code: 'consent_required' } })
    expect(await service.test()).toMatchObject({ ok: false, error: { code: 'consent_required' } })
    for (const r of Object.values(requests)) expect(service.start(r)).toMatchObject({ error: { code: 'consent_required' } })
    await new Promise((r) => setTimeout(r, 50))
  }

  beforeEach(async () => {
    events.length = 0
    dir = await mkdtemp(join(tmpdir(), 'inkling-consent-'))
    server = await startBetaServer()
    gemini.requests.length = 0
  })
  afterEach(async () => server?.close())

  it('a fresh install on the cloud AI sends nothing at all, not even a status check, before consent', async () => {
    const { service } = await makeService()
    expect(service.status()).toMatchObject({ provider: 'cloud', consented: false, cloud: { consented: false, quota: null } })
    await tryEverything(service)
    expect(server.requests).toEqual([])
    expect(server.ai.calls).toEqual([])
  })

  it('after consent the allowance check and answers go through; withdrawing stops them again', async () => {
    const { service } = await makeService()
    await service.setConsent(true)
    await new Promise((r) => setTimeout(r, 50))
    // Allowing shows today's allowance: one status check, no model call.
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/status'])
    expect(server.ai.calls).toEqual([])
    expect(service.status().cloud.quota).not.toBeNull()

    await service.setConsent(false)
    expect(service.status().cloud.quota).toBeNull()
    const before = server.requests.length
    await tryEverything(service)
    expect(server.requests.length).toBe(before)
  })

  it('declining sends nothing and records no consent', async () => {
    const { service } = await makeService()
    await service.setConsent(false)
    await tryEverything(service)
    expect(server.requests).toEqual([])
    const saved = JSON.parse(await readFile(join(dir, 'ai-settings.json'), 'utf8'))
    expect(saved.cloudConsent).toBeNull()
  })

  it('switching provider never grants consent to another provider, and sends nothing on the way', async () => {
    const { service, config } = await makeService({ provider: 'ollama' })
    // Gemini consent and a key, but not the cloud AI's.
    await config.setProvider('gemini')
    await config.setKey(VALID_KEY)
    await service.setConsent(true)
    expect(service.status()).toMatchObject({ provider: 'gemini', consented: true, cloud: { consented: false } })

    await service.setProvider('cloud')
    expect(service.status()).toMatchObject({ provider: 'cloud', consented: false, geminiConsented: true })
    await tryEverything(service)
    expect(server.requests).toEqual([])

    // And the reverse: the cloud AI's consent doesn't carry over to Gemini.
    await service.setConsent(true)
    await service.setProvider('gemini')
    await service.setConsent(false)
    expect(service.status()).toMatchObject({ provider: 'gemini', consented: false, cloud: { consented: true } })
    const sent = gemini.requests.length
    await tryEverything(service)
    expect(gemini.requests.length).toBe(sent)
    // Through Ollama and back to the cloud AI: its own consent is still there, and only its own.
    await service.setProvider('ollama')
    await service.setProvider('cloud')
    expect(service.status()).toMatchObject({ provider: 'cloud', consented: true, geminiConsented: false })
  })

  it('Gemini: neither the key check nor the model list reaches Google before consent', async () => {
    const { service, config } = await makeService({ provider: 'gemini' })
    await config.setKey(VALID_KEY)
    await tryEverything(service)
    expect(gemini.requests).toEqual([])
    await service.setConsent(true)
    expect(await service.test()).toMatchObject({ ok: true })
    expect(gemini.requests.length).toBeGreaterThan(0)
  })

  it('agreement to an older notice no longer counts: asked again, nothing sent, other settings kept', async () => {
    const installId = 'inst_existingInstallationId0123456789'
    await writeFile(
      join(dir, 'ai-settings.json'),
      JSON.stringify({
        version: 3,
        provider: 'cloud',
        models: { gemini: 'gemini-3.5-flash-lite', ollama: 'qwen3-vl:2b-instruct' },
        consent: { version: 2, acceptedAt: '2026-10-30T10:00:00.000Z' },
        cloudConsent: { version: 2, acceptedAt: '2026-10-30T10:00:00.000Z' },
        cloudUrl: null,
        installId
      })
    )
    const { service, config } = await makeService()
    expect(CLOUD_CONSENT_VERSION).toBeGreaterThan(2)
    expect(CONSENT_VERSION).toBeGreaterThan(2)
    expect(config.cloudConsented).toBe(false)
    expect(config.consented).toBe(false)
    expect(config.installId).toBe(installId)
    expect(config.geminiModel).toBe('gemini-3.5-flash-lite')
    expect(config.ollamaModel).toBe('qwen3-vl:2b-instruct')
    await tryEverything(service)
    expect(server.requests).toEqual([])

    await service.setConsent(true)
    const saved = JSON.parse(await readFile(join(dir, 'ai-settings.json'), 'utf8'))
    expect(saved.cloudConsent.version).toBe(CLOUD_CONSENT_VERSION)
    expect(saved.installId).toBe(installId)
    // The old Gemini agreement is untouched: still on record, still not counted.
    expect(saved.consent.version).toBe(2)
  })

  it('agreement to the current notice is kept across restarts without asking again', async () => {
    const first = await makeService()
    await first.service.setConsent(true)
    const again = await makeService()
    expect(again.config.cloudConsented).toBe(true)
    expect(again.service.status().consented).toBe(true)
  })

  it('what reaches the server is exactly what the notice lists', async () => {
    const { service, config } = await makeService()
    await service.setConsent(true)
    await new Promise((r) => setTimeout(r, 50))
    server.requests.length = 0
    // A follow-up: earlier exchanges with an image, then a text-only question.
    const history: ThreadEntry[] = []
    for (let i = 0; i < 7; i++) {
      history.push({ role: 'user', parts: [{ text: `<page title="Algebra">\nTyped text:\nline ${i}\n</page>` }, { image: { mimeType: 'image/jpeg', data: IMAGE } }, { text: `Question ${i}` }], ok: true })
      history.push({ role: 'model', parts: [{ text: `Answer ${i}` }], ok: true })
    }
    const turns = buildTurns(history, [{ text: 'Why are the roots negative?' }])
    const r = service.start({ task: 'chat', turns })
    if ('error' in r) throw new Error(r.error.message)
    for (let i = 0; i < 200 && !events.some((e) => e.requestId === r.requestId && e.type !== 'delta'); i++) await new Promise((res) => setTimeout(res, 10))

    const tutor = server.requests.find((x) => x.path === '/v1/tutor')!
    expect(tutor).toBeTruthy()
    // Body: only the task and the conversation (the server adds its own instructions).
    expect(Object.keys(tutor.body).sort()).toEqual(['task', 'turns'])
    // Identity: only the installation ID; no account, key or name.
    expect(tutor.headers['x-inkling-install']).toBe(config.installId)
    expect(Object.keys(tutor.headers).filter((h) => /auth|key|token|user|cookie|email/i.test(h) && h !== 'user-agent')).toEqual([])

    const sent = tutor.body.turns as Array<{ role: string; parts: Array<{ text?: string; image?: unknown }> }>
    const earlierQuestions = sent.filter((t) => t.role === 'user').length - 1
    const earlierImages = sent.slice(0, -1).flatMap((t) => t.parts).filter((p) => p.image).length
    // "up to your last 5 questions … and the most recent earlier image"
    expect(earlierQuestions).toBe(HISTORY_ENTRIES / 2)
    expect(earlierImages).toBe(1)
    const item = (id: string): string => CLOUD_SENT.find((x) => x.id === id)!.text
    expect(item('history')).toContain(`last ${HISTORY_ENTRIES / 2} questions`)
    expect(item('history')).toMatch(/most recent earlier image/)
    expect(item('history')).toMatch(/tutor’s answers/)
    expect(item('context')).toMatch(/selection/)
    for (const word of ['title', 'typed text', 'PDF text', 'handwriting', 'note page']) expect(item('context')).toContain(word)
    expect(item('metadata')).toMatch(/installation’s random ID/)
    expect(item('metadata')).toMatch(/IP\) address/)
    expect(item('tasks')).toMatch(/markups, practice and answer checks/)
  })
})

describe('the notice itself', () => {
  it('lists every kind of data, for both cloud providers', () => {
    expect(CLOUD_SENT.map((i) => i.id)).toEqual(['question', 'context', 'history', 'tasks', 'metadata'])
    // Google gets the content but not Inkling's installation ID.
    expect(GEMINI_SENT.map((i) => i.id)).toEqual(['question', 'context', 'history', 'tasks'])
    expect(CLOUD_WHEN_SENT).toMatch(/not even a check of today’s allowance/)
  })

  it('says what Allow is not: no age check, no verified parental consent, shared on this computer account', () => {
    expect(CLOUD_PERMISSION_SCOPE).toMatch(/does not check ages/)
    expect(CLOUD_PERMISSION_SCOPE).toMatch(/does not verify a parent’s or guardian’s consent/)
    expect(CLOUD_PERMISSION_SCOPE).toMatch(/everyone who uses Inkling on this computer account/)
    expect(CLOUD_PERMISSION_SCOPE).toMatch(/Notebooks work fully without the AI/)
  })

  it('every field the context builder reads from a page is one the notice names', async () => {
    // A tripwire: if the context builder starts sending another field of the page,
    // this fails until the notice (and its version) are updated.
    const src = await readFile(join(import.meta.dirname, '../../src/renderer/src/ai/context.ts'), 'utf8')
    const used = [...new Set([...src.matchAll(/content\.(\w+)/g)].map((m) => m[1]))].sort()
    expect(used).toEqual(['kind', 'markdown', 'objects', 'page', 'pdfText', 'textBoxes'])
  })

  it('changing the wording of the cloud notice requires a new consent version', () => {
    const text = JSON.stringify([CLOUD_SENT, CLOUD_WHEN_SENT, CLOUD_DATA_NOTE, CLOUD_PERMISSION_SCOPE])
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
    // If this fails, the notice changed: raise CLOUD_CONSENT_VERSION in src/shared/ai.ts, then record the new hash here.
    expect({ version: CLOUD_CONSENT_VERSION, hash }).toEqual({ version: 4, hash: NOTICE_HASH_V4 })
  })
})

describe('tutor history and the provider', () => {
  it('sends earlier messages only to the provider that handled them', () => {
    const thread = [
      { id: 'a', role: 'user', provider: 'ollama' },
      { id: 'b', role: 'model', provider: 'ollama' },
      { id: 'c', role: 'user', provider: 'cloud' },
      { id: 'd', role: 'model', provider: 'cloud' },
      { id: 'e', role: 'user' }
    ]
    expect(historyFor(thread, 'cloud').map((m) => m.id)).toEqual(['c', 'd'])
    expect(historyFor(thread, 'ollama').map((m) => m.id)).toEqual(['a', 'b'])
    expect(historyFor(thread, 'gemini')).toEqual([])
    expect(historyFor(thread, undefined)).toEqual([])
  })
})

/** sha256 (first 16 hex) of the cloud notice at CLOUD_CONSENT_VERSION 4 (DeepInfra, Workers AI as backup, monthly count). */
const NOTICE_HASH_V4 = 'd8c8238bb5c436c2'
