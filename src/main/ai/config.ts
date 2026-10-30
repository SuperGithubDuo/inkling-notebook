/**
 * AI settings (provider, model per provider, consent for each cloud provider,
 * the anonymous installation ID for the cloud AI's fair-use limits) and the
 * Gemini API key, stored in the app's private config folder —
 * never in the notebook library, so keys can't end up in synced or shared
 * notebooks. The key is encrypted with the operating system's keychain
 * (Electron safeStorage). Where no keychain is available it is kept in memory
 * for this session only and the user is told so.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import {
  CLOUD_CONSENT_VERSION,
  installIdSchema,
  CLOUD_MODEL,
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
  version: z.literal(3),
  provider: providerIdSchema,
  models: z.object({ gemini: geminiModelIdSchema, ollama: ollamaModelIdSchema }),
  /** Agreement to send notebook content to Google (Gemini only). */
  consent: consentSchema,
  /** Agreement to send notebook content to Inkling's AI server (Cloudflare Workers AI). */
  cloudConsent: consentSchema,
  /** No longer used (the server address comes with the build); kept so older files still load. */
  cloudUrl: z.string().max(300).nullable(),
  /** A random ID for this installation, sent to the cloud AI to share out its free allowance. Not secret, not an account. */
  installId: installIdSchema.optional()
})
export type AiSettings = z.infer<typeof settingsSchema>

const defaults = (provider: AiProviderId): AiSettings => ({
  version: 3,
  provider,
  models: { gemini: DEFAULT_MODEL, ollama: OLLAMA_DEFAULT_MODEL },
  consent: null,
  cloudConsent: null,
  cloudUrl: null
})

/**
 * Reads any earlier settings file. Version 1 (Phase 4) only knew Gemini; it is
 * moved to the default provider, keeping the Gemini model choice. Its consent
 * predates the age confirmation, so it is asked again (CONSENT_VERSION).
 * Version 2 (Ollama and Gemini) keeps its provider; the cloud beta starts
 * unconfigured. A fresh install starts on `defaultProvider`.
 */
export function migrateSettings(raw: unknown, defaultProvider: AiProviderId = DEFAULT_PROVIDER): AiSettings {
  const v3 = settingsSchema.safeParse(raw)
  if (v3.success) return v3.data
  const r = (raw ?? {}) as Record<string, unknown>
  const models = (r.models ?? {}) as Record<string, unknown>
  return {
    ...defaults(defaultProvider),
    provider: r.version === 2 ? (providerIdSchema.safeParse(r.provider).data ?? defaultProvider) : defaultProvider,
    models: {
      gemini: geminiModelIdSchema.safeParse(models.gemini ?? r.model).data ?? DEFAULT_MODEL,
      ollama: ollamaModelIdSchema.safeParse(models.ollama).data ?? OLLAMA_DEFAULT_MODEL
    },
    consent: consentSchema.safeParse(r.consent).data ?? null
  }
}

interface Secret {
  value: string | null
  protection: KeyProtection | null
}

export interface AiConfigOptions {
  platform?: NodeJS.Platform
  /** Provider for a fresh install: the cloud AI when this build has its server, else Ollama. */
  defaultProvider?: AiProviderId
  /** The cloud AI server address built into this version of Inkling, if any. */
  builtInCloudUrl?: string | null
}

export class AiConfig {
  private settings: AiSettings
  private readonly secrets: Record<'gemini', Secret> = { gemini: { value: null, protection: null } }
  private readonly platform: NodeJS.Platform
  private readonly defaultProvider: AiProviderId
  readonly builtInCloudUrl: string | null

  constructor(
    private readonly dir: string,
    private readonly cipher: SecretCipher,
    options: AiConfigOptions | NodeJS.Platform = {}
  ) {
    const o = typeof options === 'string' ? { platform: options } : options
    this.platform = o.platform ?? process.platform
    this.defaultProvider = o.defaultProvider ?? DEFAULT_PROVIDER
    this.builtInCloudUrl = o.builtInCloudUrl ?? null
    this.settings = defaults(this.defaultProvider)
  }

  private get settingsPath(): string {
    return join(this.dir, 'ai-settings.json')
  }
  private secretPath(_kind: 'gemini'): string {
    return join(this.dir, 'gemini-key.bin')
  }

  async load(): Promise<void> {
    try {
      // A model that is no longer offered falls back to the default (also free).
      this.settings = migrateSettings(JSON.parse(await fs.readFile(this.settingsPath, 'utf8')), this.defaultProvider)
    } catch {
      this.settings = defaults(this.defaultProvider)
    }
    await this.loadSecret('gemini')
    // Beta access codes are gone: the cloud AI needs no code. Remove a saved one.
    await fs.rm(join(this.dir, 'beta-access.bin'), { force: true }).catch(() => undefined)
    if (!this.settings.installId) {
      this.settings = { ...this.settings, installId: newInstallId() }
      await this.saveSettings().catch(() => undefined)
    }
  }

  private async loadSecret(kind: 'gemini'): Promise<void> {
    const path = this.secretPath(kind)
    try {
      const bytes = await fs.readFile(path)
      if (await this.cipher.isAsyncEncryptionAvailable()) {
        const { result, shouldReEncrypt } = await this.cipher.decryptStringAsync(bytes)
        this.secrets[kind] = { value: result, protection: this.storageProtection() }
        if (shouldReEncrypt) await atomicWrite(path, await this.cipher.encryptStringAsync(result), 0o600)
      }
    } catch {
      this.secrets[kind] = { value: null, protection: null }
    }
  }

  private async saveSecret(kind: 'gemini', value: string): Promise<KeyProtection> {
    const path = this.secretPath(kind)
    if (!(await this.cipher.isAsyncEncryptionAvailable())) {
      this.secrets[kind] = { value, protection: 'session' }
      await fs.rm(path, { force: true })
      return 'session'
    }
    await fs.mkdir(this.dir, { recursive: true })
    await atomicWrite(path, await this.cipher.encryptStringAsync(value), 0o600)
    this.secrets[kind] = { value, protection: this.storageProtection() }
    return this.secrets[kind].protection!
  }

  private async clearSecret(kind: 'gemini'): Promise<void> {
    this.secrets[kind] = { value: null, protection: null }
    await fs.rm(this.secretPath(kind), { force: true })
  }

  get provider(): AiProviderId {
    return this.settings.provider
  }
  /** The model chosen for the active provider (the cloud AI's is set by its server). */
  get model(): AiModelId {
    const p = this.settings.provider
    return p === 'cloud' ? CLOUD_MODEL : this.settings.models[p]
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
  /** Consent to send content to the cloud AI. */
  get cloudConsented(): boolean {
    return this.settings.cloudConsent?.version === CLOUD_CONSENT_VERSION
  }
  get apiKey(): string | null {
    return this.secrets.gemini.value
  }
  get keyProtection(): KeyProtection | null {
    return this.secrets.gemini.value ? this.secrets.gemini.protection : null
  }
  get keyHint(): string | null {
    return this.secrets.gemini.value?.slice(-4) ?? null
  }
  /** The cloud AI server this build came with (null: none, so the cloud AI isn't offered). */
  get cloudUrl(): string | null {
    return this.builtInCloudUrl
  }
  get cloudUrlFromBuild(): boolean {
    return !!this.builtInCloudUrl
  }
  /** This installation's anonymous ID (created on first load). */
  get installId(): string {
    if (!this.settings.installId) this.settings = { ...this.settings, installId: newInstallId() }
    return this.settings.installId!
  }

  async setCloudConsent(accepted: boolean): Promise<void> {
    this.settings = { ...this.settings, cloudConsent: accepted ? { version: CLOUD_CONSENT_VERSION, acceptedAt: new Date().toISOString() } : null }
    await this.saveSettings()
  }

  async setProvider(provider: AiProviderId): Promise<void> {
    this.settings = { ...this.settings, provider }
    await this.saveSettings()
  }

  /** Sets the model of the active provider; throws if it isn't valid for it. */
  async setModel(model: AiModelId): Promise<void> {
    const provider = this.settings.provider
    if (provider === 'cloud') throw new Error('The cloud beta’s model is chosen by its server.')
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
    return this.saveSecret('gemini', key)
  }

  async clearKey(): Promise<void> {
    await this.clearSecret('gemini')
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

/** `inst_` and 32 random URL-safe characters. */
function newInstallId(): string {
  return `inst_${randomBytes(24).toString('base64url')}`
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
