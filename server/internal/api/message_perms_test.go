package api_test

import (
	"net/http"
	"testing"

	"github.com/Calmingstorm/bastion/server/internal/permissions"
	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

func postTextMessage(h *testutil.Harness, u *testutil.TestUser, channelID, content string) int {
	return h.Request(http.MethodPost, "/api/v1/channels/"+channelID+"/messages", u.AccessToken,
		map[string]string{"content": content}, nil)
}

func listMessagesCode(h *testutil.Harness, u *testutil.TestUser, channelID string) int {
	return h.Request(http.MethodGet, "/api/v1/channels/"+channelID+"/messages", u.AccessToken, nil, nil)
}

// TestReadOnlyChannelBlocksSend: removing SendMessages from a member's role must
// actually prevent them from sending (permission-based mute / read-only channel).
func TestReadOnlyChannelBlocksSend(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	// Member can send by default.
	if code := postTextMessage(h, member, channelID, "hi"); code != http.StatusCreated {
		t.Fatalf("member send by default: expected 201, got %d", code)
	}

	// Owner strips SendMessages from the default role (keeps ViewChannel).
	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.ViewChannel|permissions.CreateInvites|permissions.AttachFiles); code != http.StatusOK {
		t.Fatalf("owner strip SendMessages: got %d", code)
	}

	if code := postTextMessage(h, member, channelID, "should fail"); code != http.StatusForbidden {
		t.Fatalf("member send without SendMessages: expected 403, got %d", code)
	}
	// The owner (privileged) can still send.
	if code := postTextMessage(h, owner, channelID, "owner still sends"); code != http.StatusCreated {
		t.Fatalf("owner send: expected 201, got %d", code)
	}
}

// TestNoViewChannelBlocksList: removing ViewChannel must prevent reading history.
func TestNoViewChannelBlocksList(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	if code := listMessagesCode(h, member, channelID); code != http.StatusOK {
		t.Fatalf("member list by default: expected 200, got %d", code)
	}

	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages|permissions.CreateInvites|permissions.AttachFiles); code != http.StatusOK {
		t.Fatalf("owner strip ViewChannel: got %d", code)
	}

	if code := listMessagesCode(h, member, channelID); code != http.StatusForbidden {
		t.Fatalf("member list without ViewChannel: expected 403, got %d", code)
	}
}

// TestDMMessagingIgnoresServerPermissions: a DM has no server, so messaging is
// governed by membership alone and the new permission gate must not break it.
func TestDMMessagingIgnoresServerPermissions(t *testing.T) {
	h := testutil.New(t)
	alice := h.Register("alice")
	bob := h.Register("bob")

	var dm struct {
		ID string `json:"id"`
	}
	code := h.Request(http.MethodPost, "/api/v1/dm", alice.AccessToken, map[string]any{"recipientIds": []string{bob.ID}}, &dm)
	if code != http.StatusOK && code != http.StatusCreated {
		t.Fatalf("create DM: expected 200/201, got %d", code)
	}
	if dm.ID == "" {
		t.Fatal("DM channel id empty")
	}

	if code := postTextMessage(h, alice, dm.ID, "hi bob"); code != http.StatusCreated {
		t.Fatalf("DM send: expected 201, got %d", code)
	}
	if code := listMessagesCode(h, bob, dm.ID); code != http.StatusOK {
		t.Fatalf("DM list: expected 200, got %d", code)
	}
}
