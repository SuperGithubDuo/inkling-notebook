import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/** Optional tests against a real local model in Ollama: npm run test:live */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@': resolve(import.meta.dirname, 'src/renderer/src')
    }
  },
  // One model, one request at a time: run the scenario files one after another.
  test: { include: ['tests/live/**/*.live.test.ts'], environment: 'node', fileParallelism: false }
})
