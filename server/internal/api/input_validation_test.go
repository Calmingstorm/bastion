package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// TestSendRejectsJavascriptEmbedURL: embed URL fields must be http(s), so a
// stored javascript:/data: URL cannot execute when a client renders the embed.
func TestSendRejectsJavascriptEmbedURL(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	path := "/api/v1/channels/" + channelID + "/messages"
	bad := map[string]any{"content": "x", "embeds": []map[string]any{{"title": "t", "url": "javascript:alert(1)"}}}
	if code := h.Request(http.MethodPost, path, owner.AccessToken, bad, nil); code != http.StatusBadRequest {
		t.Fatalf("javascript embed url: expected 400, got %d", code)
	}

	badImg := map[string]any{"content": "x", "embeds": []map[string]any{{"title": "t", "image": map[string]any{"url": "data:text/html,<script>"}}}}
	if code := h.Request(http.MethodPost, path, owner.AccessToken, badImg, nil); code != http.StatusBadRequest {
		t.Fatalf("data: embed image url: expected 400, got %d", code)
	}

	good := map[string]any{"content": "x", "embeds": []map[string]any{{"title": "t", "url": "https://example.com"}}}
	if code := h.Request(http.MethodPost, path, owner.AccessToken, good, nil); code != http.StatusCreated {
		t.Fatalf("valid https embed url: expected 201, got %d", code)
	}
}

// TestWebhookExecuteValidatesOverrides: the webhook display overrides are capped
// and scheme-checked like the other write paths.
func TestWebhookExecuteValidatesOverrides(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	var wh struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	code := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/webhooks", owner.AccessToken,
		map[string]string{"name": "hook", "channelId": channelID}, &wh)
	if code != http.StatusCreated {
		t.Fatalf("create webhook: expected 201, got %d", code)
	}
	if wh.ID == "" || wh.Token == "" {
		t.Fatal("webhook id/token missing")
	}

	exec := "/api/v1/webhooks/" + wh.ID + "/" + wh.Token
	if code := h.Request(http.MethodPost, exec, "", map[string]any{"content": "hi", "username": strings.Repeat("a", 81)}, nil); code != http.StatusBadRequest {
		t.Fatalf("oversized webhook username: expected 400, got %d", code)
	}
	if code := h.Request(http.MethodPost, exec, "", map[string]any{"content": "hi", "avatarUrl": "javascript:alert(1)"}, nil); code != http.StatusBadRequest {
		t.Fatalf("bad webhook avatarUrl: expected 400, got %d", code)
	}
	if code := h.Request(http.MethodPost, exec, "", map[string]any{"content": "hi", "username": "Bot", "avatarUrl": "https://example.com/a.png"}, nil); code != http.StatusOK && code != http.StatusCreated {
		t.Fatalf("valid webhook execute: expected 200/201, got %d", code)
	}
}
