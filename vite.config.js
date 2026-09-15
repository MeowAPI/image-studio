import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  define: { __APP_VERSION__: JSON.stringify('standalone') },
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
})
