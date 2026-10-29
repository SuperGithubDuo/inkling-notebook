import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/** The real-API smoke test, run against the local fake Gemini server: npm run test:smoke:fake */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@': resolve(import.meta.dirname, 'src/renderer/src')
    }
  },
  test: { include: ['tests/smoke/**/*.smoke.test.ts'], environment: 'node', env: { INKLING_SMOKE_FAKE: '1' } }
})
