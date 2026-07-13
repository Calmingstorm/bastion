package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/Calmingstorm/bastion/server/internal/models"
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

// TestSendRejectsHostlessEmbedURL: a scheme-only or opaque "http(s)" value has no
// host and is not a valid absolute target — it must be rejected, not treated as a
// valid URL just because it starts with http.
func TestSendRejectsHostlessEmbedURL(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	path := "/api/v1/channels/" + channelID + "/messages"

	for _, bad := range []string{"https://", "http:", "https:javascript:alert(1)", `https:\evil.example`} {
		body := map[string]any{"content": "x", "embeds": []map[string]any{{"title": "t", "url": bad}}}
		if code := h.Request(http.MethodPost, path, owner.AccessToken, body, nil); code != http.StatusBadRequest {
			t.Fatalf("hostless embed url %q: expected 400, got %d", bad, code)
		}
	}
}

// webhookAuthorOverride returns the author_override stored on the most recent
// message in a channel (the value actually persisted, not what was validated).
func webhookAuthorOverride(h *testutil.Harness, channelID string) models.AuthorOverride {
	h.T.Helper()
	var raw []byte
	err := h.Pool.QueryRow(context.Background(),
		`SELECT author_override FROM messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 1`,
		channelID,
	).Scan(&raw)
	if err != nil {
		h.T.Fatalf("read author_override: %v", err)
	}
	var ao models.AuthorOverride
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &ao); err != nil {
			h.T.Fatalf("decode author_override: %v", err)
		}
	}
	return ao
}

// TestWebhookOverridePersistsNormalizedValue: the username cap and avatar checks
// must apply to the value that is actually stored, not to a trimmed copy while the
// raw (padded) value is persisted. Padding must not smuggle past the length cap.
func TestWebhookOverridePersistsNormalizedValue(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	var wh struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if code := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/webhooks", owner.AccessToken,
		map[string]string{"name": "hook", "channelId": channelID}, &wh); code != http.StatusCreated {
		t.Fatalf("create webhook: expected 201, got %d", code)
	}
	exec := "/api/v1/webhooks/" + wh.ID + "/" + wh.Token

	// A padded but valid username is stored trimmed.
	if code := h.Request(http.MethodPost, exec, "", map[string]any{"content": "a", "username": "  Padded  "}, nil); code != http.StatusOK && code != http.StatusCreated {
		t.Fatalf("padded username execute: got %d", code)
	}
	if got := webhookAuthorOverride(h, channelID).Username; got != "Padded" {
		t.Fatalf("stored username = %q, want %q (trimmed)", got, "Padded")
	}

	// 81 spaces trims to empty, so it can never be stored at length 81.
	if code := h.Request(http.MethodPost, exec, "", map[string]any{"content": "b", "username": strings.Repeat(" ", 81)}, nil); code != http.StatusOK && code != http.StatusCreated {
		t.Fatalf("whitespace username execute: got %d", code)
	}
	if got := webhookAuthorOverride(h, channelID).Username; len(got) > 80 {
		t.Fatalf("stored username length = %d, want <= 80", len(got))
	}
}

// setupInteractionToken creates a bot, a command, and a live interaction token,
// returning the token string so callback-route tests can exercise it.
func setupInteractionToken(h *testutil.Harness, owner *testutil.TestUser, serverID, channelID, token string) {
	h.T.Helper()
	var bot struct {
		ID string `json:"id"`
	}
	// Bot usernames are unique, so derive a distinct one per token (alphanumeric).
	botName := "cmdbot" + strings.ReplaceAll(token, "-", "")
	if code := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/bots", owner.AccessToken,
		map[string]string{"username": botName}, &bot); code != http.StatusCreated {
		h.T.Fatalf("create bot: got %d", code)
	}
	ctx := context.Background()
	var commandID string
	if err := h.Pool.QueryRow(ctx,
		`INSERT INTO application_commands (server_id, bot_id, name) VALUES ($1, $2, $3) RETURNING id`,
		serverID, bot.ID, "ping",
	).Scan(&commandID); err != nil {
		h.T.Fatalf("insert command: %v", err)
	}
	if _, err := h.Pool.Exec(ctx,
		`INSERT INTO interaction_tokens (server_id, channel_id, command_id, bot_id, invoker_id, token, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '10 minutes')`,
		serverID, channelID, commandID, bot.ID, owner.ID, token,
	); err != nil {
		h.T.Fatalf("insert interaction token: %v", err)
	}
}

func channelMessageCount(h *testutil.Harness, channelID string) int {
	h.T.Helper()
	var n int
	if err := h.Pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM messages WHERE channel_id = $1`, channelID,
	).Scan(&n); err != nil {
		h.T.Fatalf("count messages: %v", err)
	}
	return n
}

// TestInteractionCallbackEnforcesLimits: the callback route must apply the content
// cap and embed-URL validation it previously skipped.
func TestInteractionCallbackEnforcesLimits(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	setupInteractionToken(h, owner, serverID, channelID, "tok-limits")
	path := "/api/v1/interactions/tok-limits/callback"

	// Oversized content is rejected (the token survives a 400).
	if code := h.Request(http.MethodPost, path, "", map[string]any{"content": strings.Repeat("a", 4001)}, nil); code != http.StatusBadRequest {
		t.Fatalf("oversized callback content: expected 400, got %d", code)
	}
	// An unsafe embed URL is rejected.
	bad := map[string]any{"embeds": []map[string]any{{"title": "t", "url": "javascript:alert(1)"}}}
	if code := h.Request(http.MethodPost, path, "", bad, nil); code != http.StatusBadRequest {
		t.Fatalf("unsafe callback embed url: expected 400, got %d", code)
	}
}

// TestInteractionCallbackPersistedAndEphemeral: a valid callback succeeds; the
// persisted branch stores a message and the ephemeral branch does not.
func TestInteractionCallbackPersistedAndEphemeral(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	// Persisted branch: a real message is stored.
	setupInteractionToken(h, owner, serverID, channelID, "tok-persist")
	before := channelMessageCount(h, channelID)
	if code := h.Request(http.MethodPost, "/api/v1/interactions/tok-persist/callback", "",
		map[string]any{"content": "hello", "ephemeral": false}, nil); code != http.StatusNoContent {
		t.Fatalf("persisted callback: expected 204, got %d", code)
	}
	if after := channelMessageCount(h, channelID); after != before+1 {
		t.Fatalf("persisted callback message count: got %d, want %d", after, before+1)
	}

	// Ephemeral branch: nothing is stored.
	setupInteractionToken(h, owner, serverID, channelID, "tok-ephemeral")
	before = channelMessageCount(h, channelID)
	if code := h.Request(http.MethodPost, "/api/v1/interactions/tok-ephemeral/callback", "",
		map[string]any{"content": "secret", "ephemeral": true}, nil); code != http.StatusNoContent {
		t.Fatalf("ephemeral callback: expected 204, got %d", code)
	}
	if after := channelMessageCount(h, channelID); after != before {
		t.Fatalf("ephemeral callback must not persist: count went %d -> %d", before, after)
	}
}
