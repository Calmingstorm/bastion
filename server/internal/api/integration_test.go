package api_test

import (
	"net/http"
	"testing"

	"github.com/Calmingstorm/bastion/server/internal/permissions"
	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// TestRegisterLoginMe exercises the full auth round-trip through the real router.
func TestRegisterLoginMe(t *testing.T) {
	h := testutil.New(t)
	user := h.Register("alice")

	var me struct {
		ID       string `json:"id"`
		Username string `json:"username"`
	}
	if code := h.Request(http.MethodGet, "/api/v1/users/me", user.AccessToken, nil, &me); code != http.StatusOK {
		t.Fatalf("GET /users/me: expected 200, got %d", code)
	}
	if me.Username != "alice" {
		t.Fatalf("GET /users/me: expected username alice, got %q", me.Username)
	}
	if me.ID != user.ID {
		t.Fatalf("GET /users/me: id mismatch: %q vs %q", me.ID, user.ID)
	}

	// Login with the same credentials should also succeed and return a token.
	var login struct {
		AccessToken string `json:"accessToken"`
	}
	code := h.Request(http.MethodPost, "/api/v1/auth/login", "",
		map[string]string{"email": user.Email, "password": user.Password}, &login)
	if code != http.StatusOK {
		t.Fatalf("POST /auth/login: expected 200, got %d", code)
	}
	if login.AccessToken == "" {
		t.Fatal("POST /auth/login: empty access token")
	}
}

// TestUnauthenticatedRejected confirms the auth middleware rejects missing tokens.
func TestUnauthenticatedRejected(t *testing.T) {
	h := testutil.New(t)
	if code := h.Request(http.MethodGet, "/api/v1/users/me", "", nil, nil); code != http.StatusUnauthorized {
		t.Fatalf("GET /users/me without token: expected 401, got %d", code)
	}
}

// TestCreateServerDefaultRole verifies a new server gets the @bastion default
// role with exactly the documented default permission set.
func TestCreateServerDefaultRole(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "Test Server")

	var roles []struct {
		Name        string `json:"name"`
		Permissions int64  `json:"permissions"`
		IsDefault   bool   `json:"isDefault"`
	}
	if code := h.Request(http.MethodGet, "/api/v1/servers/"+serverID+"/roles", owner.AccessToken, nil, &roles); code != http.StatusOK {
		t.Fatalf("GET roles: expected 200, got %d", code)
	}

	var def *struct {
		Name        string `json:"name"`
		Permissions int64  `json:"permissions"`
		IsDefault   bool   `json:"isDefault"`
	}
	for i := range roles {
		if roles[i].IsDefault {
			def = &roles[i]
			break
		}
	}
	if def == nil {
		t.Fatal("no default role found on new server")
	}
	if def.Name != "@bastion" {
		t.Fatalf("default role name: expected @bastion, got %q", def.Name)
	}
	want := permissions.ViewChannel | permissions.SendMessages | permissions.CreateInvites | permissions.AttachFiles
	if def.Permissions != want {
		t.Fatalf("default role permissions: expected %d, got %d", want, def.Permissions)
	}
}

// TestServerOwnerHasAllPermissions confirms the owner resolves to full perms.
func TestServerOwnerHasAllPermissions(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("boss")
	serverID := h.CreateServer(owner, "Owned")

	var perms struct {
		Permissions int64 `json:"permissions"`
	}
	if code := h.Request(http.MethodGet, "/api/v1/servers/"+serverID+"/permissions", owner.AccessToken, nil, &perms); code != http.StatusOK {
		t.Fatalf("GET permissions: expected 200, got %d", code)
	}
	if perms.Permissions != permissions.AllPermissions {
		t.Fatalf("owner permissions: expected AllPermissions (%d), got %d", permissions.AllPermissions, perms.Permissions)
	}
}
