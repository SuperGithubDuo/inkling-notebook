import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// WISP runs as its own Vite app, separate from Inkling's electron-vite build.
export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the build also works from a sub-folder or file server.
  base: './',
  server: { port: 5191, strictPort: false },
  build: { target: 'es2022', sourcemap: true }
})
