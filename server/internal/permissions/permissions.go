package permissions

import "github.com/google/uuid"

// Permission bitfield constants.
const (
	ViewChannel      int64 = 1 << 0  // 0x1
	SendMessages     int64 = 1 << 1  // 0x2
	ManageMessages   int64 = 1 << 2  // 0x4   — delete others' messages
	ManageChannels   int64 = 1 << 3  // 0x8
	ManageRoles      int64 = 1 << 4  // 0x10
	ManageServer     int64 = 1 << 5  // 0x20
	CreateInvites    int64 = 1 << 6  // 0x40
	KickMembers      int64 = 1 << 7  // 0x80
	BanMembers       int64 = 1 << 8  // 0x100
	AttachFiles      int64 = 1 << 9  // 0x200
	ManageNicknames  int64 = 1 << 10 // 0x400
	MentionEveryone  int64 = 1 << 11 // 0x800
	Administrator    int64 = 1 << 12 // 0x1000 — bypasses all checks
	ManageCategories int64 = 1 << 13 // 0x2000
	TimeoutMembers   int64 = 1 << 14 // 0x4000
)

// AllPermissions is the union of every defined permission.
var AllPermissions = ViewChannel | SendMessages | ManageMessages | ManageChannels |
	ManageRoles | ManageServer | CreateInvites | KickMembers | BanMembers |
	AttachFiles | ManageNicknames | MentionEveryone | Administrator |
	ManageCategories | TimeoutMembers

// Has checks whether perms includes every bit in check.
func Has(perms, check int64) bool {
	return perms&check == check
}

// Role represents a server role with a permission bitfield.
type Role struct {
	ID          uuid.UUID
	ServerID    uuid.UUID
	Name        string
	Color       *string
	Position    int
	Permissions int64
	IsDefault   bool
}

// Override represents a per-channel permission override.
type Override struct {
	TargetType string // "role" or "member"
	TargetID   uuid.UUID
	Allow      int64
	Deny       int64
}

// ComputeBase computes a member's server-level permissions from their roles.
// The owner always gets all permissions.
func ComputeBase(ownerID, userID uuid.UUID, roles []Role) int64 {
	if ownerID == userID {
		return AllPermissions
	}
	var perms int64
	for _, r := range roles {
		perms |= r.Permissions
	}
	if Has(perms, Administrator) {
		return AllPermissions
	}
	return perms
}

// ComputeChannel applies channel-level overrides to base permissions.
func ComputeChannel(base int64, userID uuid.UUID, userRoleIDs []uuid.UUID, overrides []Override) int64 {
	if Has(base, Administrator) {
		return AllPermissions
	}

	// Start with base permissions
	perms := base

	// 1. Apply @bastion (default role) overrides first — they're the lowest-position role overrides.
	//    We process all role overrides in one pass; the caller should order them by role position.
	var roleAllow, roleDeny int64
	roleSet := make(map[uuid.UUID]struct{}, len(userRoleIDs))
	for _, rid := range userRoleIDs {
		roleSet[rid] = struct{}{}
	}

	for _, o := range overrides {
		if o.TargetType == "role" {
			if _, ok := roleSet[o.TargetID]; ok {
				roleAllow |= o.Allow
				roleDeny |= o.Deny
			}
		}
	}
	perms = (perms &^ roleDeny) | roleAllow

	// 2. Apply member-specific override last (highest priority)
	for _, o := range overrides {
		if o.TargetType == "member" && o.TargetID == userID {
			perms = (perms &^ o.Deny) | o.Allow
		}
	}

	return perms
}
