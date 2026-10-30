/** Build-time settings for the main process (electron-vite exposes MAIN_VITE_* variables). */
interface ImportMetaEnv {
  /** The cloud AI server built into this version, e.g. https://inkling-ai-beta.example.workers.dev */
  readonly MAIN_VITE_INKLING_BETA_URL?: string
  /** `auto` (signed builds), `notify` (default) or `off`. See src/main/updater.ts. */
  readonly MAIN_VITE_INKLING_UPDATE_MODE?: string
  /** Where "Send feedback" goes (https page or mailto:). Defaults to new GitHub issue. */
  readonly MAIN_VITE_INKLING_FEEDBACK_URL?: string
}
