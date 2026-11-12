/// <reference types="vite/client" />
import type { InklingApi } from '@shared/ipc'

declare global {
  interface Window {
    inkling: InklingApi
  }
}

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_INKLING_BETA_URL?: string
  readonly VITE_INKLING_FEEDBACK_URL?: string
}
