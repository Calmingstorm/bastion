// Registers the jest-dom matchers (toBeInTheDocument, toHaveTextContent, ...)
// and their vitest type augmentation, and runs before every test file via
// vitest.config.ts setupFiles.
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Unmount anything a test rendered so tests stay isolated from each other.
afterEach(() => {
  cleanup()
})
