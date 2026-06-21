import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      // forward API calls (HTTP + the Deepgram audio WebSocket) to the backend
      '/api': { target: process.env.VITE_API_TARGET || 'http://localhost:8787', ws: true },
    },
  },
})
