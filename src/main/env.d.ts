/** Build-time settings for the main process (electron-vite exposes MAIN_VITE_* variables). */
interface ImportMetaEnv {
  /** The cloud AI server built into this version, e.g. https://inkling-ai-beta.example.workers.dev */
  readonly MAIN_VITE_INKLING_BETA_URL?: string
  /** `auto`, `notify` or `off`; unset: auto on Windows, notify on macOS. See src/main/updatePolicy.ts. */
  readonly MAIN_VITE_INKLING_UPDATE_MODE?: string
  /** '1' when the release workflow code-signed this build (updates are then publisher-authenticated too). */
  readonly MAIN_VITE_INKLING_SIGNED?: string
  /** Where "Send feedback" goes (https page or mailto:). Defaults to new GitHub issue. */
  readonly MAIN_VITE_INKLING_FEEDBACK_URL?: string
  /** '1' offers Google Gemini in a packaged build. Unset: no Gemini (public all-ages builds). Development always has it. */
  readonly MAIN_VITE_INKLING_ENABLE_GEMINI?: string
  /** Accounts and sync: the Supabase project's URL and public (anon) key. Unset: no accounts; everything stays on this computer. */
  readonly MAIN_VITE_SUPABASE_URL?: string
  readonly MAIN_VITE_SUPABASE_ANON_KEY?: string
}
