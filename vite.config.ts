import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      // forward API calls to the thin backend proxy (server/index.js)
      '/api': 'http://localhost:8787',
    },
  },
})
