import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves this repository from /talk/. Capacitor and local
  // builds keep relative asset URLs so the same bundle still works via file://.
  base: process.env.VITE_DEPLOY_TARGET === 'github-pages' ? '/talk/' : './',
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: true,
    port: 5173,
  },
})
