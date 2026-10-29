/** Build-time settings for the main process (electron-vite exposes MAIN_VITE_* variables). */
interface ImportMetaEnv {
  /** The cloud beta server built into this version, e.g. https://inkling-ai-beta.example.workers.dev */
  readonly MAIN_VITE_INKLING_BETA_URL?: string
}
