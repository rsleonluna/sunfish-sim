/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // sim-core must stay headless: no DOM, no browser globals.
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
})
