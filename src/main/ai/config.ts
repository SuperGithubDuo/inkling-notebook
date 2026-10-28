/**
 * AI settings and the API key, stored in the app's private config folder —
 * never in the notebook library, so keys can't end up in synced or shared
 * notebooks. The key is encrypted with the operating system's keychain
 * (Electron safeStorage). Where no keychain is available it is kept in memory
 * for this session only and the user is told so.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { CONSENT_VERSION, DEFAULT_MODEL, modelIdSchema, type AiModelId, type KeyProtection } from '@shared/ai'

/** The parts of Electron's safeStorage this module uses. */
export interface SecretCipher {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plain: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
  getSelectedStorageBackend?(): string
}

const settingsSchema = z.object({
  version: z.literal(1),
  provider: z.literal('gemini'),
  model: modelIdSchema,
  consent: z.object({ version: z.number().int(), acceptedAt: z.string() }).nullable()
})
export type AiSettings = z.infer<typeof settingsSchema>

const DEFAULTS: AiSettings = { version: 1, provider: 'gemini', model: DEFAULT_MODEL, consent: null }

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
      const raw = JSON.parse(await fs.readFile(this.settingsPath, 'utf8'))
      const parsed = settingsSchema.safeParse(raw)
      // A model that is no longer offered falls back to the default (also free).
      this.settings = parsed.success ? parsed.data : { ...DEFAULTS, consent: settingsSchema.shape.consent.safeParse(raw?.consent).data ?? null }
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

  get model(): AiModelId {
    return this.settings.model
  }
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

  async setModel(model: AiModelId): Promise<void> {
    this.settings = { ...this.settings, model }
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
