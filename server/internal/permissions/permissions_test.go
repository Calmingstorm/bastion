package permissions

import (
	"testing"

	"github.com/google/uuid"
)

func TestHas(t *testing.T) {
	tests := []struct {
		name  string
		perms int64
		check int64
		want  bool
	}{
		{"exact single bit", SendMessages, SendMessages, true},
		{"missing bit", ViewChannel, SendMessages, false},
		{"superset has subset", ViewChannel | SendMessages | ManageRoles, SendMessages, true},
		{"multi-bit check all present", ViewChannel | SendMessages, ViewChannel | SendMessages, true},
		{"multi-bit check one missing", ViewChannel, ViewChannel | SendMessages, false},
		{"zero check always true", SendMessages, 0, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Has(tt.perms, tt.check); got != tt.want {
				t.Fatalf("Has(%d,%d)=%v, want %v", tt.perms, tt.check, got, tt.want)
			}
		})
	}
}

func TestComputeBaseOwnerGetsAll(t *testing.T) {
	owner := uuid.New()
	// Owner has no explicit roles but must resolve to all permissions.
	if got := ComputeBase(owner, owner, nil); got != AllPermissions {
		t.Fatalf("owner base = %d, want AllPermissions %d", got, AllPermissions)
	}
}

func TestComputeBaseAdministratorGetsAll(t *testing.T) {
	owner, user := uuid.New(), uuid.New()
	roles := []Role{{Permissions: Administrator | ViewChannel}}
	if got := ComputeBase(owner, user, roles); got != AllPermissions {
		t.Fatalf("administrator base = %d, want AllPermissions %d", got, AllPermissions)
	}
}

func TestComputeBaseUnionsRoles(t *testing.T) {
	owner, user := uuid.New(), uuid.New()
	roles := []Role{
		{Permissions: ViewChannel | SendMessages},
		{Permissions: ManageRoles | KickMembers},
	}
	want := ViewChannel | SendMessages | ManageRoles | KickMembers
	if got := ComputeBase(owner, user, roles); got != want {
		t.Fatalf("union base = %d, want %d", got, want)
	}
}

func TestComputeChannelAdministratorBypassesOverrides(t *testing.T) {
	user := uuid.New()
	base := Administrator
	overrides := []Override{{TargetType: "member", TargetID: user, Deny: ViewChannel}}
	// Administrator must ignore a deny override entirely.
	if got := ComputeChannel(base, user, nil, overrides); got != AllPermissions {
		t.Fatalf("admin channel perms = %d, want AllPermissions", got)
	}
}

func TestComputeChannelRoleDenyThenMemberAllow(t *testing.T) {
	user := uuid.New()
	roleID := uuid.New()
	base := ViewChannel | SendMessages

	// A role override denies SendMessages; a member override re-allows it.
	overrides := []Override{
		{TargetType: "role", TargetID: roleID, Deny: SendMessages},
		{TargetType: "member", TargetID: user, Allow: SendMessages},
	}
	got := ComputeChannel(base, user, []uuid.UUID{roleID}, overrides)
	if !Has(got, SendMessages) {
		t.Fatalf("member allow should override role deny: perms=%d", got)
	}
}

func TestComputeChannelMemberDenyWins(t *testing.T) {
	user := uuid.New()
	base := ViewChannel | SendMessages
	overrides := []Override{{TargetType: "member", TargetID: user, Deny: SendMessages}}
	got := ComputeChannel(base, user, nil, overrides)
	if Has(got, SendMessages) {
		t.Fatalf("member deny should remove SendMessages: perms=%d", got)
	}
	if !Has(got, ViewChannel) {
		t.Fatalf("member deny should not touch ViewChannel: perms=%d", got)
	}
}

func TestComputeChannelIgnoresUnrelatedOverrides(t *testing.T) {
	user := uuid.New()
	otherRole := uuid.New()
	otherMember := uuid.New()
	base := ViewChannel | SendMessages
	overrides := []Override{
		{TargetType: "role", TargetID: otherRole, Deny: SendMessages},    // user isn't in this role
		{TargetType: "member", TargetID: otherMember, Deny: ViewChannel}, // different member
	}
	got := ComputeChannel(base, user, nil, overrides)
	if got != base {
		t.Fatalf("unrelated overrides should not apply: got %d want %d", got, base)
	}
}

func TestAllPermissionsContainsEveryBit(t *testing.T) {
	all := []int64{
		ViewChannel, SendMessages, ManageMessages, ManageChannels, ManageRoles,
		ManageServer, CreateInvites, KickMembers, BanMembers, AttachFiles,
		ManageNicknames, MentionEveryone, Administrator, ManageCategories,
		TimeoutMembers, ManageCommands,
	}
	for _, bit := range all {
		if !Has(AllPermissions, bit) {
			t.Fatalf("AllPermissions missing bit %d", bit)
		}
	}
}
