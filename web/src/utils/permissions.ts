// Permission bitfield constants — must match server/internal/permissions/permissions.go
export const PERMISSIONS = {
  ViewChannel:      1 << 0,   // 0x1
  SendMessages:     1 << 1,   // 0x2
  ManageMessages:   1 << 2,   // 0x4
  ManageChannels:   1 << 3,   // 0x8
  ManageRoles:      1 << 4,   // 0x10
  ManageServer:     1 << 5,   // 0x20
  CreateInvites:    1 << 6,   // 0x40
  KickMembers:      1 << 7,   // 0x80
  BanMembers:       1 << 8,   // 0x100
  AttachFiles:      1 << 9,   // 0x200
  ManageNicknames:  1 << 10,  // 0x400
  MentionEveryone:  1 << 11,  // 0x800
  Administrator:    1 << 12,  // 0x1000
  ManageCategories: 1 << 13,  // 0x2000
  TimeoutMembers:   1 << 14,  // 0x4000
  ManageCommands:   1 << 15,  // 0x8000
} as const;

/** Check whether `perms` includes every bit in `flag`. */
export function hasFlag(perms: number, flag: number): boolean {
  return (perms & flag) === flag;
}
