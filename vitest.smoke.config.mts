import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/** Optional real-API smoke test: GEMINI_API_KEY=… npm run test:smoke */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@': resolve(import.meta.dirname, 'src/renderer/src')
    }
  },
  test: { include: ['tests/smoke/**/*.smoke.test.ts'], environment: 'node' }
})
