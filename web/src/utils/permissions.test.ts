import { describe, it, expect } from 'vitest'
import { PERMISSIONS, hasFlag } from './permissions'

describe('PERMISSIONS bitfield', () => {
  // This is a wire contract with the Go server
  // (server/internal/permissions/permissions.go); drift breaks authorization in
  // subtle ways. Pinning the WHOLE map with toEqual catches a changed bit, a
  // missing permission, or an extra one — not just the few spot-checked before.
  it('matches the exact server bit map', () => {
    expect(PERMISSIONS).toEqual({
      ViewChannel: 0x1,
      SendMessages: 0x2,
      ManageMessages: 0x4,
      ManageChannels: 0x8,
      ManageRoles: 0x10,
      ManageServer: 0x20,
      CreateInvites: 0x40,
      KickMembers: 0x80,
      BanMembers: 0x100,
      AttachFiles: 0x200,
      ManageNicknames: 0x400,
      MentionEveryone: 0x800,
      Administrator: 0x1000,
      ManageCategories: 0x2000,
      TimeoutMembers: 0x4000,
      ManageCommands: 0x8000,
    })
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
