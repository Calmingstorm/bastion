// Registers the jest-dom matchers (toBeInTheDocument, toHaveTextContent, ...)
// and their vitest type augmentation, and runs before every test file via
// vitest.config.ts setupFiles.
import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom does not implement matchMedia; components using the responsive hooks call
// it at mount. Provide a minimal always-false stub so they render in tests.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

// Unmount anything a test rendered so tests stay isolated from each other.
afterEach(() => {
  cleanup()
})
