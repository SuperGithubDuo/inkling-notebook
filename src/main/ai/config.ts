/**
 * AI settings (provider, model per provider, Gemini consent) and the Gemini API key, stored in the app's private config folder —
 * never in the notebook library, so keys can't end up in synced or shared
 * notebooks. The key is encrypted with the operating system's keychain
 * (Electron safeStorage). Where no keychain is available it is kept in memory
 * for this session only and the user is told so.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  CONSENT_VERSION,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  OLLAMA_DEFAULT_MODEL,
  geminiModelIdSchema,
  ollamaModelIdSchema,
  providerIdSchema,
  type AiModelId,
  type AiProviderId,
  type GeminiModelId,
  type KeyProtection
} from '@shared/ai'

/** The parts of Electron's safeStorage this module uses. */
export interface SecretCipher {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plain: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
  getSelectedStorageBackend?(): string
}

const consentSchema = z.object({ version: z.number().int(), acceptedAt: z.string() }).nullable()

const settingsSchema = z.object({
  version: z.literal(2),
  provider: providerIdSchema,
  models: z.object({ gemini: geminiModelIdSchema, ollama: ollamaModelIdSchema }),
  /** Agreement to send notebook content to Google (Gemini only). */
  consent: consentSchema
})
export type AiSettings = z.infer<typeof settingsSchema>

const DEFAULTS: AiSettings = { version: 2, provider: DEFAULT_PROVIDER, models: { gemini: DEFAULT_MODEL, ollama: OLLAMA_DEFAULT_MODEL }, consent: null }

/**
 * Reads any earlier settings file. Version 1 (Phase 4) only knew Gemini; it is
 * moved to the local default provider, keeping the Gemini model choice. Its
 * consent predates the age confirmation, so it is asked again (CONSENT_VERSION).
 */
export function migrateSettings(raw: unknown): AiSettings {
  const v2 = settingsSchema.safeParse(raw)
  if (v2.success) return v2.data
  const r = (raw ?? {}) as Record<string, unknown>
  const models = (r.models ?? {}) as Record<string, unknown>
  return {
    version: 2,
    provider: r.version === 2 ? (providerIdSchema.safeParse(r.provider).data ?? DEFAULT_PROVIDER) : DEFAULT_PROVIDER,
    models: {
      gemini: geminiModelIdSchema.safeParse(models.gemini ?? r.model).data ?? DEFAULT_MODEL,
      ollama: ollamaModelIdSchema.safeParse(models.ollama).data ?? OLLAMA_DEFAULT_MODEL
    },
    consent: consentSchema.safeParse(r.consent).data ?? null
  }
}

export class AiConfig {
  private settings: AiSettings = { ...DEFAULTS }
  private key: string | null = null
  private protection: KeyProtection | null = null

  constructor(
    private readonly dir: string,
    private readonly cipher: SecretCipher,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  private get settingsPath(): string {
    return join(this.dir, 'ai-settings.json')
  }
  private get keyPath(): string {
    return join(this.dir, 'gemini-key.bin')
  }

  async load(): Promise<void> {
    try {
      // A model that is no longer offered falls back to the default (also free).
      this.settings = migrateSettings(JSON.parse(await fs.readFile(this.settingsPath, 'utf8')))
    } catch {
      this.settings = { ...DEFAULTS }
    }
    try {
      const bytes = await fs.readFile(this.keyPath)
      if (await this.cipher.isAsyncEncryptionAvailable()) {
        const { result, shouldReEncrypt } = await this.cipher.decryptStringAsync(bytes)
        this.key = result
        this.protection = this.storageProtection()
        if (shouldReEncrypt) await atomicWrite(this.keyPath, await this.cipher.encryptStringAsync(result), 0o600)
      }
    } catch {
      this.key = null
      this.protection = null
    }
  }

  get provider(): AiProviderId {
    return this.settings.provider
  }
  /** The model chosen for the active provider. */
  get model(): AiModelId {
    return this.settings.models[this.settings.provider]
  }
  get geminiModel(): GeminiModelId {
    return this.settings.models.gemini
  }
  get ollamaModel(): string {
    return this.settings.models.ollama
  }
  /** Gemini data-use consent (local providers need none). */
  get consented(): boolean {
    return this.settings.consent?.version === CONSENT_VERSION
  }
  get apiKey(): string | null {
    return this.key
  }
  get keyProtection(): KeyProtection | null {
    return this.key ? this.protection : null
  }
  get keyHint(): string | null {
    return this.key ? this.key.slice(-4) : null
  }

  async setProvider(provider: AiProviderId): Promise<void> {
    this.settings = { ...this.settings, provider }
    await this.saveSettings()
  }

  /** Sets the model of the active provider; throws if it isn't valid for it. */
  async setModel(model: AiModelId): Promise<void> {
    const provider = this.settings.provider
    const id = provider === 'gemini' ? geminiModelIdSchema.parse(model) : ollamaModelIdSchema.parse(model)
    this.settings = { ...this.settings, models: { ...this.settings.models, [provider]: id } }
    await this.saveSettings()
  }

  async setConsent(accepted: boolean): Promise<void> {
    this.settings = { ...this.settings, consent: accepted ? { version: CONSENT_VERSION, acceptedAt: new Date().toISOString() } : null }
    await this.saveSettings()
  }

  /** Stores the key encrypted if the OS allows it, otherwise only for this session. */
  async setKey(key: string): Promise<KeyProtection> {
    this.key = key
    if (!(await this.cipher.isAsyncEncryptionAvailable())) {
      this.protection = 'session'
      await fs.rm(this.keyPath, { force: true })
      return this.protection
    }
    await fs.mkdir(this.dir, { recursive: true })
    await atomicWrite(this.keyPath, await this.cipher.encryptStringAsync(key), 0o600)
    this.protection = this.storageProtection()
    return this.protection
  }

  async clearKey(): Promise<void> {
    this.key = null
    this.protection = null
    await fs.rm(this.keyPath, { force: true })
  }

  /** On Linux without a keyring, Chromium falls back to a fixed, weak password. */
  private storageProtection(): KeyProtection {
    if (this.platform === 'linux' && this.cipher.getSelectedStorageBackend?.() === 'basic_text') return 'weak'
    return 'encrypted'
  }

  private async saveSettings(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    await atomicWrite(this.settingsPath, Buffer.from(JSON.stringify(this.settings, null, 2)), 0o600)
  }
}

async function atomicWrite(path: string, bytes: Buffer, mode: number): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  const fh = await fs.open(tmp, 'w', mode)
  try {
    await fh.writeFile(bytes)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fs.rename(tmp, path)
}
