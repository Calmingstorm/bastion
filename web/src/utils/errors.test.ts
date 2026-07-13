import { describe, it, expect } from 'vitest'
import { extractErrorMessage } from './errors'

describe('extractErrorMessage', () => {
  it('reads the structured { error: { code, message } } format', () => {
    const err = { response: { data: { error: { code: 'FORBIDDEN', message: 'nope' } } } }
    expect(extractErrorMessage(err, 'fallback')).toBe('nope')
  })

  it('reads the legacy { message } format', () => {
    const err = { response: { data: { message: 'legacy message' } } }
    expect(extractErrorMessage(err, 'fallback')).toBe('legacy message')
  })

  it('reads the legacy string { error } format', () => {
    const err = { response: { data: { error: 'string error' } } }
    expect(extractErrorMessage(err, 'fallback')).toBe('string error')
  })

  it('falls back when the shape is unrecognized or absent', () => {
    expect(extractErrorMessage(new Error('raw'), 'fallback')).toBe('fallback')
    expect(extractErrorMessage(null, 'fallback')).toBe('fallback')
    expect(extractErrorMessage({ response: { data: {} } }, 'fallback')).toBe('fallback')
  })
})
