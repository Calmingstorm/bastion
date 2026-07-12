package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// thumbsUp is the URL-encoded 👍 emoji used as a reaction path parameter.
const thumbsUp = "%F0%9F%91%8D"

func sendMessage(h *testutil.Harness, u *testutil.TestUser, channelID, content string) string {
	h.T.Helper()
	var out struct {
		ID string `json:"id"`
	}
	code := h.Request(http.MethodPost, "/api/v1/channels/"+channelID+"/messages", u.AccessToken,
		map[string]string{"content": content}, &out)
	if code != http.StatusCreated {
		h.T.Fatalf("send message: expected 201, got %d", code)
	}
	return out.ID
}

func addReaction(h *testutil.Harness, u *testutil.TestUser, channelID, messageID, emoji string) int {
	return h.Request(http.MethodPut, "/api/v1/channels/"+channelID+"/messages/"+messageID+"/reactions/"+emoji, u.AccessToken, nil, nil)
}

func removeReaction(h *testutil.Harness, u *testutil.TestUser, channelID, messageID, emoji string) int {
	return h.Request(http.MethodDelete, "/api/v1/channels/"+channelID+"/messages/"+messageID+"/reactions/"+emoji, u.AccessToken, nil, nil)
}

// reactionCount returns the count for a given emoji on a message, via the list.
func reactionCount(h *testutil.Harness, u *testutil.TestUser, channelID, messageID, emoji string) int {
	h.T.Helper()
	var msgs []struct {
		ID        string `json:"id"`
		Reactions []struct {
			Emoji string `json:"emoji"`
			Count int    `json:"count"`
		} `json:"reactions"`
	}
	code := h.Request(http.MethodGet, "/api/v1/channels/"+channelID+"/messages", u.AccessToken, nil, &msgs)
	if code != http.StatusOK {
		h.T.Fatalf("list messages: expected 200, got %d", code)
	}
	for _, m := range msgs {
		if m.ID != messageID {
			continue
		}
		for _, rx := range m.Reactions {
			if rx.Emoji == emoji {
				return rx.Count
			}
		}
	}
	return 0
}

// TestOutsiderCannotReact: a non-member must not add or remove reactions in a
// channel they cannot access (IDOR regression).
func TestOutsiderCannotReact(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	outsider := h.Register("outsider")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	messageID := sendMessage(h, owner, channelID, "hello")

	if code := addReaction(h, outsider, channelID, messageID, thumbsUp); code != http.StatusForbidden {
		t.Fatalf("outsider add reaction: expected 403, got %d", code)
	}
	if code := removeReaction(h, outsider, channelID, messageID, thumbsUp); code != http.StatusForbidden {
		t.Fatalf("outsider remove reaction: expected 403, got %d", code)
	}
	// And no reaction should have been recorded.
	if n := reactionCount(h, owner, channelID, messageID, "👍"); n != 0 {
		t.Fatalf("expected 0 reactions after blocked attempts, got %d", n)
	}
}

// TestMemberCanReactOnceIdempotent: a member can react, and a duplicate add does
// not inflate the count.
func TestMemberCanReactOnceIdempotent(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	messageID := sendMessage(h, owner, channelID, "hello")

	if code := addReaction(h, owner, channelID, messageID, thumbsUp); code != http.StatusOK {
		t.Fatalf("member add reaction: expected 200, got %d", code)
	}
	// Duplicate add is accepted but must remain idempotent.
	if code := addReaction(h, owner, channelID, messageID, thumbsUp); code != http.StatusOK {
		t.Fatalf("duplicate add reaction: expected 200, got %d", code)
	}
	if n := reactionCount(h, owner, channelID, messageID, "👍"); n != 1 {
		t.Fatalf("expected reaction count 1 after duplicate add, got %d", n)
	}

	// Remove returns to zero; a second remove is a no-op.
	if code := removeReaction(h, owner, channelID, messageID, thumbsUp); code != http.StatusOK {
		t.Fatalf("remove reaction: expected 200, got %d", code)
	}
	if n := reactionCount(h, owner, channelID, messageID, "👍"); n != 0 {
		t.Fatalf("expected reaction count 0 after remove, got %d", n)
	}
}

// TestRemoveReactionCrossChannelBlocked: a reaction must only be removable
// through the channel its message actually belongs to, not by routing the
// request through a different channel the caller can access.
func TestRemoveReactionCrossChannelBlocked(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	attacker := h.Register("attacker")
	serverID := h.CreateServer(owner, "S")
	chanA := h.CreateChannel(owner, serverID, "a")
	chanB := h.CreateChannel(owner, serverID, "b")
	joinServer(h, owner, attacker, serverID)

	msgB := sendMessage(h, owner, chanB, "in B")
	if code := addReaction(h, attacker, chanB, msgB, thumbsUp); code != http.StatusOK {
		t.Fatalf("attacker react in B: expected 200, got %d", code)
	}

	// Removing via chanA (accessible) but referencing a message in chanB must 404.
	if code := removeReaction(h, attacker, chanA, msgB, thumbsUp); code != http.StatusNotFound {
		t.Fatalf("cross-channel reaction remove: expected 404, got %d", code)
	}
	// The reaction in B must survive.
	if n := reactionCount(h, owner, chanB, msgB, "👍"); n != 1 {
		t.Fatalf("reaction removed cross-channel: count=%d, want 1", n)
	}
}

// TestReactionBroadcastIdempotent: a duplicate add emits exactly one
// REACTION_ADD, and a duplicate remove exactly one REACTION_REMOVE, observed
// over a real authenticated WebSocket.
func TestReactionBroadcastIdempotent(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)
	messageID := sendMessage(h, owner, channelID, "hi")

	ws := h.DialWS(owner)
	ws.Drain(400 * time.Millisecond) // discard connect/presence/join noise

	// Two identical adds must produce exactly one broadcast.
	_ = addReaction(h, member, channelID, messageID, thumbsUp)
	_ = addReaction(h, member, channelID, messageID, thumbsUp)
	if n := ws.CountEvents("REACTION_ADD", 800*time.Millisecond); n != 1 {
		t.Fatalf("expected exactly 1 REACTION_ADD broadcast, got %d", n)
	}

	// Two removes must produce exactly one broadcast.
	_ = removeReaction(h, member, channelID, messageID, thumbsUp)
	_ = removeReaction(h, member, channelID, messageID, thumbsUp)
	if n := ws.CountEvents("REACTION_REMOVE", 800*time.Millisecond); n != 1 {
		t.Fatalf("expected exactly 1 REACTION_REMOVE broadcast, got %d", n)
	}
}
