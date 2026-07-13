import { describe, it, expect } from 'vitest'
import { PERMISSIONS, hasFlag } from './permissions'

describe('PERMISSIONS bitfield', () => {
  // These values are a wire contract with the Go server
  // (server/internal/permissions/permissions.go); drift breaks authorization
  // in subtle ways, so pin the exact bits here.
  it('matches the server bit values', () => {
    expect(PERMISSIONS.ViewChannel).toBe(0x1)
    expect(PERMISSIONS.SendMessages).toBe(0x2)
    expect(PERMISSIONS.ManageMessages).toBe(0x4)
    expect(PERMISSIONS.Administrator).toBe(0x1000)
    expect(PERMISSIONS.ManageCommands).toBe(0x8000)
  })

  it('assigns a unique power-of-two bit to every permission', () => {
    const values = Object.values(PERMISSIONS)
    expect(new Set(values).size).toBe(values.length)
    for (const v of values) {
      expect(v & (v - 1)).toBe(0) // exactly one bit set
    }
  })
})

describe('hasFlag', () => {
  const combined = PERMISSIONS.ViewChannel | PERMISSIONS.SendMessages

  it('is true only when every requested bit is present', () => {
    expect(hasFlag(combined, PERMISSIONS.ViewChannel)).toBe(true)
    expect(hasFlag(combined, PERMISSIONS.SendMessages)).toBe(true)
    expect(hasFlag(combined, PERMISSIONS.ViewChannel | PERMISSIONS.SendMessages)).toBe(true)
  })

  it('is false when a requested bit is missing', () => {
    expect(hasFlag(combined, PERMISSIONS.ManageMessages)).toBe(false)
    expect(hasFlag(combined, PERMISSIONS.ViewChannel | PERMISSIONS.ManageMessages)).toBe(false)
    expect(hasFlag(0, PERMISSIONS.ViewChannel)).toBe(false)
  })
})
