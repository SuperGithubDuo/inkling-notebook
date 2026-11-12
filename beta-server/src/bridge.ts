/**
 * Per-request choice between DeepInfra and the Workers AI bridge for older apps, and each one's
 * server settings. No Workers runtime imports, so the rules are unit-tested (tests/unit/bridge.test.ts).
 */
import { sha256Hex, type ServerConfig } from './handler'
import { webOrigins, type inference, type Env } from './config'
import { textModelFrom } from './route'

type WorkerEnv = Env

/** The Worker's server settings for one provider (shared by the main path and the bridge for older apps). */
export async function serverConfig(env: WorkerEnv, inf: Exclude<ReturnType<typeof inference>, string>, legacy: boolean): Promise<ServerConfig> {
  return {
    model: inf.model,
    allowedOrigins: webOrigins(env.WEB_ORIGINS),
    provider: inf.provider,
    publicModel: inf.publicModel,
    // The bridge answers apps whose notice names only Cloudflare: no notice gate there.
    minNoticeVersion: legacy ? 0 : inf.minNotice,
    inputMargin: inf.inputMargin,
    upstreamAttempts: inf.upstreamAttempts ?? 1,
    rates: inf.rates,
    reasoningEffort: env.REASONING_EFFORT ?? '',
    disableThinking: env.DISABLE_THINKING === 'true',
    structured: env.STRUCTURED === 'json_schema' ? 'json_schema' : 'prompt',
    imagePatch: Number(env.IMAGE_PATCH) || 28,
    maxBodyBytes: 3_500_000,
    maxInputTokens: Number(env.MAX_INPUT_TOKENS) || 12_000,
    adminTokenHash: env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 32 ? await sha256Hex(env.ADMIN_TOKEN) : null,
    // Text-only routing (route.ts) applies on Workers AI only: the rollback, and the bridge for older apps,
    // which keeps them exactly as production serves them today (practice sets on Gemma 4 26B, everything
    // else on Qwen). DeepInfra answers every request with the one model (Qwen 3.8 27B).
    textModel: inf.provider === 'workers-ai' ? textModelFrom(env, env.MODEL) : null
  }
}

/**
 * The bridge for apps released before the DeepInfra notice (CLOUD_CONSENT_VERSION 4), set by
 * LEGACY_WORKERS_AI="true" while the server uses an external provider. Those apps' users agreed to a
 * notice that names only Cloudflare, so their requests must not go to DeepInfra: they are answered by
 * Workers AI, as before the switch, with Qwen 3.8 27B, under the Workers Free plan's limits and in a
 * separate ledger (Neurons, GLOBAL_DAILY_NEURONS etc.). They cost nothing and never touch the dollar
 * budget. Apps on notice 4 or later go to the external provider. Turn the bridge off once old
 * versions are gone: those apps then get "Update Inkling".
 */
export function isLegacyApp(request: Request, minNotice: number): boolean {
  const n = Number(request.headers.get('x-inkling-notice') ?? '0')
  return !(Number.isFinite(n) && n >= minNotice)
}

