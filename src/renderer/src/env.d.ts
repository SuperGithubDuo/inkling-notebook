/// <reference types="vite/client" />
import type { InklingApi } from '@shared/ipc'

declare global {
  interface Window {
    inkling: InklingApi
  }
}
