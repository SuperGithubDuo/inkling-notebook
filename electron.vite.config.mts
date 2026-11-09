import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { phonepadPagePlugin } from './scripts/phonepadPage.mjs'

const shared = { '@shared': resolve(import.meta.dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    // The PhonePad phone page, bundled into one HTML string the main process serves.
    plugins: [phonepadPagePlugin(import.meta.dirname)]
  },
  preload: {
    resolve: { alias: shared },
    build: {
      // Sandboxed preloads must be CommonJS.
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } }
    }
  },
  renderer: {
    resolve: { alias: { ...shared, '@': resolve(import.meta.dirname, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    build: { minify: true }
  }
})
