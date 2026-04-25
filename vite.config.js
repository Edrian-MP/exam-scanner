import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/exam-scanner/dist/',
  server: {
    host: true,
    proxy: {
      '/exam-scanner/backend/api': {
        target: 'http://localhost',
        changeOrigin: true,
      },
    },
  },
})
