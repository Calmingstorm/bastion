package api_test

import (
	"net/http"
	"testing"

	"github.com/Calmingstorm/bastion/server/internal/permissions"
	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// --- flow helpers (kept local to the test package) --------------------------

func createRole(h *testutil.Harness, u *testutil.TestUser, serverID, name string, perms int64) (string, int) {
	var out struct {
		ID string `json:"id"`
	}
	code := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/roles", u.AccessToken,
		map[string]any{"name": name, "permissions": perms}, &out)
	return out.ID, code
}

func assignRole(h *testutil.Harness, u *testutil.TestUser, serverID, roleID, targetID string) int {
	return h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/roles/"+roleID+"/assign", u.AccessToken,
		map[string]string{"userId": targetID}, nil)
}

func patchRolePerms(h *testutil.Harness, u *testutil.TestUser, serverID, roleID string, perms int64) int {
	return h.Request(http.MethodPatch, "/api/v1/servers/"+serverID+"/roles/"+roleID, u.AccessToken,
		map[string]any{"permissions": perms}, nil)
}

func memberPerms(h *testutil.Harness, u *testutil.TestUser, serverID string) int64 {
	var out struct {
		Permissions int64 `json:"permissions"`
	}
	h.Request(http.MethodGet, "/api/v1/servers/"+serverID+"/permissions", u.AccessToken, nil, &out)
	return out.Permissions
}

func defaultRoleID(h *testutil.Harness, u *testutil.TestUser, serverID string) string {
	var roles []struct {
		ID        string `json:"id"`
		IsDefault bool   `json:"isDefault"`
	}
	h.Request(http.MethodGet, "/api/v1/servers/"+serverID+"/roles", u.AccessToken, nil, &roles)
	for _, r := range roles {
		if r.IsDefault {
			return r.ID
		}
	}
	return ""
}

// joinServer has owner mint an invite and member redeem it.
func joinServer(h *testutil.Harness, owner, member *testutil.TestUser, serverID string) {
	h.T.Helper()
	var inv struct {
		Code string `json:"code"`
	}
	if code := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/invites", owner.AccessToken, map[string]any{}, &inv); code != http.StatusCreated && code != http.StatusOK {
		h.T.Fatalf("create invite: got %d", code)
	}
	if code := h.Request(http.MethodPost, "/api/v1/invites/"+inv.Code+"/join", member.AccessToken, nil, nil); code != http.StatusOK && code != http.StatusCreated {
		h.T.Fatalf("join via invite: got %d", code)
	}
}

// makeModerator gives a member a fresh role carrying exactly perms, returning the role ID.
func makeModerator(h *testutil.Harness, owner, member *testutil.TestUser, serverID string, perms int64, name string) string {
	h.T.Helper()
	roleID, code := createRole(h, owner, serverID, name, perms)
	if code != http.StatusCreated {
		h.T.Fatalf("owner create %s role: got %d", name, code)
	}
	if code := assignRole(h, owner, serverID, roleID, member.ID); code != http.StatusOK {
		h.T.Fatalf("owner assign %s role: got %d", name, code)
	}
	return roleID
}

// --- escalation must be blocked ---------------------------------------------

// F5: a member holding only ManageRoles must not create an Administrator role.
func TestMemberCannotCreateAdministratorRole(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	joinServer(h, owner, member, serverID)
	makeModerator(h, owner, member, serverID, permissions.ManageRoles, "Mod")

	_, code := createRole(h, member, serverID, "Pwn", permissions.Administrator)
	if code != http.StatusForbidden {
		t.Fatalf("member created an Administrator role: expected 403, got %d", code)
	}
}

// F5b/F6: a ManageRoles member must not assign a higher (Administrator) role.
func TestMemberCannotSelfAssignHigherRole(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	joinServer(h, owner, member, serverID)
	makeModerator(h, owner, member, serverID, permissions.ManageRoles, "Mod")

	// Owner creates a high Administrator role (positioned above the mod role).
	adminRole, code := createRole(h, owner, serverID, "Admin", permissions.Administrator)
	if code != http.StatusCreated {
		t.Fatalf("owner create admin role: got %d", code)
	}

	if code := assignRole(h, member, serverID, adminRole, member.ID); code != http.StatusForbidden {
		t.Fatalf("member self-assigned a higher role: expected 403, got %d", code)
	}
	if permissions.Has(memberPerms(h, member, serverID), permissions.Administrator) {
		t.Fatal("member unexpectedly gained Administrator")
	}
}

// F4: a ManageRoles member must not edit the @bastion default role to add Administrator.
func TestMemberCannotEditDefaultRoleToAdmin(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	joinServer(h, owner, member, serverID)
	makeModerator(h, owner, member, serverID, permissions.ManageRoles, "Mod")

	def := defaultRoleID(h, member, serverID)
	if def == "" {
		t.Fatal("no default role")
	}
	if code := patchRolePerms(h, member, serverID, def, permissions.Administrator); code != http.StatusForbidden {
		t.Fatalf("member edited @bastion to Administrator: expected 403, got %d", code)
	}
}

// Subset: a ManageRoles member must not grant a permission bit they lack.
func TestMemberCannotGrantPermissionsTheyLack(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	joinServer(h, owner, member, serverID)
	// Mod has ManageRoles but NOT BanMembers.
	makeModerator(h, owner, member, serverID, permissions.ManageRoles, "Mod")

	if _, code := createRole(h, member, serverID, "Banner", permissions.BanMembers); code != http.StatusForbidden {
		t.Fatalf("member granted BanMembers they lack: expected 403, got %d", code)
	}
}

// F7: a junior moderator must not kick a higher-ranked member.
func TestJuniorModCannotKickHigherRankedMember(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	junior := h.Register("junior")
	senior := h.Register("senior")
	serverID := h.CreateServer(owner, "S")
	joinServer(h, owner, junior, serverID)
	joinServer(h, owner, senior, serverID)

	makeModerator(h, owner, junior, serverID, permissions.KickMembers, "Junior")
	// Senior gets a higher role (created later => higher position).
	makeModerator(h, owner, senior, serverID, permissions.Administrator, "Senior")

	code := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/kick/"+senior.ID, junior.AccessToken, nil, nil)
	if code != http.StatusForbidden {
		t.Fatalf("junior kicked a higher-ranked member: expected 403, got %d", code)
	}
}

// --- legitimate role management must still work -----------------------------

// The owner is privileged and may create an Administrator role.
func TestOwnerCanCreateAdministratorRole(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	if _, code := createRole(h, owner, serverID, "Admins", permissions.Administrator); code != http.StatusCreated {
		t.Fatalf("owner create admin role: expected 201, got %d", code)
	}
}

// A ManageRoles holder may create a role whose permissions are within their own.
func TestManageRolesHolderCanCreateRoleWithinTheirPerms(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	joinServer(h, owner, member, serverID)
	makeModerator(h, owner, member, serverID, permissions.ManageRoles|permissions.CreateInvites, "Mod")

	if _, code := createRole(h, member, serverID, "Greeters", permissions.CreateInvites); code != http.StatusCreated {
		t.Fatalf("mod create role within perms: expected 201, got %d", code)
	}
}

// A moderator may kick a lower-ranked (default-only) member.
func TestModeratorCanKickLowerRankedMember(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	mod := h.Register("mod")
	plain := h.Register("plain")
	serverID := h.CreateServer(owner, "S")
	joinServer(h, owner, mod, serverID)
	joinServer(h, owner, plain, serverID)
	makeModerator(h, owner, mod, serverID, permissions.KickMembers, "Mod")

	code := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/kick/"+plain.ID, mod.AccessToken, nil, nil)
	if code != http.StatusOK {
		t.Fatalf("mod kick lower-ranked member: expected 200, got %d", code)
	}
}
