import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { manualUpdates } from './dev/manual-updates.ts'

// https://vite.dev/config/
export default defineConfig({
  base: '/machitsumugi/',
  plugins: [react(), manualUpdates()],
})
