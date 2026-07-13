import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Test configuration is kept separate from vite.config.ts so the production
// build stays untouched. jsdom + React Testing Library give component tests a
// DOM; pure utilities run without one just as well.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
