import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const projectFile = (path) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  root: projectFile('./preview'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: [{ find: /^\.\/lib\/api$/, replacement: projectFile('./preview/demo-api.js') }],
  },
  build: {
    outDir: projectFile('./docs'),
    emptyOutDir: true,
  },
})
