package api_test

import (
	"context"
	"crypto/sha256"
	"net/http"
	"testing"

	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

func newWebhook(h *testutil.Harness, owner *testutil.TestUser, serverID, channelID string) (id, token, hint string) {
	h.T.Helper()
	var wh struct {
		ID        string `json:"id"`
		Token     string `json:"token"`
		TokenHint string `json:"tokenHint"`
	}
	code := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/webhooks", owner.AccessToken,
		map[string]string{"name": "hook", "channelId": channelID}, &wh)
	if code != http.StatusCreated {
		h.T.Fatalf("create webhook: expected 201, got %d", code)
	}
	return wh.ID, wh.Token, wh.TokenHint
}

func execWebhook(h *testutil.Harness, id, token string) int {
	return h.Request(http.MethodPost, "/api/v1/webhooks/"+id+"/"+token, "",
		map[string]any{"content": "hi"}, nil)
}

// TestWebhookTokenHashedAtRestAndOneTimeReveal: create returns the plaintext token
// and a hint once; the DB stores only the SHA-256 hash; list/get expose the hint,
// never the token.
func TestWebhookTokenHashedAtRestAndOneTimeReveal(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	id, token, hint := newWebhook(h, owner, serverID, channelID)
	if token == "" || hint == "" {
		t.Fatal("create must return the plaintext token and a hint")
	}
	if hint != token[len(token)-8:] {
		t.Fatalf("hint %q should be the last 8 chars of the token", hint)
	}

	// The stored hash equals SHA-256 of the token; there is no plaintext column.
	var stored []byte
	if err := h.Pool.QueryRow(context.Background(),
		`SELECT token_hash FROM webhooks WHERE id = $1`, id).Scan(&stored); err != nil {
		t.Fatalf("read token_hash: %v", err)
	}
	want := sha256.Sum256([]byte(token))
	if len(stored) != sha256.Size || string(stored) != string(want[:]) {
		t.Fatal("stored token_hash is not SHA-256 of the token")
	}

	// List and Get expose the hint but never the token.
	var list []map[string]any
	if code := h.Request(http.MethodGet, "/api/v1/servers/"+serverID+"/webhooks", owner.AccessToken, nil, &list); code != http.StatusOK {
		t.Fatalf("list: got %d", code)
	}
	if len(list) != 1 || list[0]["token"] != nil {
		t.Fatalf("list must hide the token, got %v", list)
	}
	if list[0]["tokenHint"] != hint {
		t.Fatalf("list should include the hint, got %v", list[0]["tokenHint"])
	}

	var got map[string]any
	if code := h.Request(http.MethodGet, "/api/v1/servers/"+serverID+"/webhooks/"+id, owner.AccessToken, nil, &got); code != http.StatusOK {
		t.Fatalf("get: got %d", code)
	}
	if got["token"] != nil {
		t.Fatal("get must not return the token")
	}
}

// TestWebhookExecuteVerifiesToken: the right token executes, the wrong one is 401.
func TestWebhookExecuteVerifiesToken(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	id, token, _ := newWebhook(h, owner, serverID, channelID)

	if code := execWebhook(h, id, token); code != http.StatusOK && code != http.StatusCreated {
		t.Fatalf("correct token: expected 200/201, got %d", code)
	}
	if code := execWebhook(h, id, "whk_wrongtoken"); code != http.StatusUnauthorized {
		t.Fatalf("wrong token: expected 401, got %d", code)
	}
}

// TestWebhookRegenerateToken: regeneration invalidates the old token, returns a
// working new token once, and the old token no longer executes.
func TestWebhookRegenerateToken(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	id, oldToken, _ := newWebhook(h, owner, serverID, channelID)

	var regen struct {
		Token     string `json:"token"`
		TokenHint string `json:"tokenHint"`
	}
	if code := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/webhooks/"+id+"/regenerate-token",
		owner.AccessToken, map[string]any{}, &regen); code != http.StatusOK {
		t.Fatalf("regenerate: got %d", code)
	}
	if regen.Token == "" || regen.Token == oldToken {
		t.Fatal("regenerate must return a new plaintext token")
	}

	if code := execWebhook(h, id, oldToken); code != http.StatusUnauthorized {
		t.Fatalf("old token after regenerate: expected 401, got %d", code)
	}
	if code := execWebhook(h, id, regen.Token); code != http.StatusOK && code != http.StatusCreated {
		t.Fatalf("new token: expected 200/201, got %d", code)
	}
}

// The real migration backfill (010 plaintext -> 011 hash, and the down rotation)
// is covered by TestMigration011HashesExistingPlaintextWebhook.
