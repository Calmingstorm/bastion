package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/Calmingstorm/bastion/server/internal/permissions"
	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

func deleteMessage(h *testutil.Harness, u *testutil.TestUser, channelID, messageID string) int {
	return h.Request(http.MethodDelete, "/api/v1/channels/"+channelID+"/messages/"+messageID, u.AccessToken, nil, nil)
}

func pinMessage(h *testutil.Harness, u *testutil.TestUser, channelID, messageID string) int {
	return h.Request(http.MethodPut, "/api/v1/channels/"+channelID+"/pins/"+messageID, u.AccessToken, nil, nil)
}

func unpinMessage(h *testutil.Harness, u *testutil.TestUser, channelID, messageID string) int {
	return h.Request(http.MethodDelete, "/api/v1/channels/"+channelID+"/pins/"+messageID, u.AccessToken, nil, nil)
}

func ackChannel(h *testutil.Harness, u *testutil.TestUser, channelID, messageID string) int {
	return h.Request(http.MethodPost, "/api/v1/channels/"+channelID+"/ack", u.AccessToken,
		map[string]string{"messageId": messageID}, nil)
}

func readStateChannelIDs(h *testutil.Harness, u *testutil.TestUser) []string {
	h.T.Helper()
	var states []struct {
		ChannelID string `json:"channelId"`
	}
	if code := h.Request(http.MethodGet, "/api/v1/users/me/read-states", u.AccessToken, nil, &states); code != http.StatusOK {
		h.T.Fatalf("list read states: expected 200, got %d", code)
	}
	ids := make([]string, 0, len(states))
	for _, s := range states {
		ids = append(ids, s.ChannelID)
	}
	return ids
}

// TestRevokingViewChannelUnsubscribesLiveSocket: an already-connected member must
// stop receiving MESSAGE_CREATE once a role edit removes ViewChannel — connect /
// join-time filtering is not enough, the mutation must reconcile subscriptions.
func TestRevokingViewChannelUnsubscribesLiveSocket(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	// Control: while subscribed, the member receives channel messages.
	_ = postTextMessage(h, owner, channelID, "before revocation")
	if n := ws.CountEvents("MESSAGE_CREATE", 700*time.Millisecond); n == 0 {
		t.Fatal("member should receive messages while they can view the channel")
	}

	// Revoke ViewChannel via the default role; this must reconcile the live socket.
	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages|permissions.CreateInvites|permissions.AttachFiles); code != http.StatusOK {
		t.Fatalf("strip ViewChannel: got %d", code)
	}
	// Give the hub time to process the unsubscribe queued by the reconcile.
	ws.Drain(500 * time.Millisecond)

	_ = postTextMessage(h, owner, channelID, "after revocation")
	if n := ws.CountEvents("MESSAGE_CREATE", 700*time.Millisecond); n != 0 {
		t.Fatalf("member received %d MESSAGE_CREATE after losing ViewChannel, want 0", n)
	}
}

// TestGrantingViewChannelSubscribesLiveSocket: the reciprocal — assigning a role
// that grants access to a member with an open socket must start delivery without
// a reconnect.
func TestGrantingViewChannelSubscribesLiveSocket(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	// Default role cannot view; the member joins with no visibility.
	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages|permissions.CreateInvites|permissions.AttachFiles); code != http.StatusOK {
		t.Fatalf("strip ViewChannel: got %d", code)
	}
	joinServer(h, owner, member, serverID)

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	// Sanity: no delivery before a grant.
	_ = postTextMessage(h, owner, channelID, "still hidden")
	if n := ws.CountEvents("MESSAGE_CREATE", 500*time.Millisecond); n != 0 {
		t.Fatalf("member received %d MESSAGE_CREATE before any grant, want 0", n)
	}

	// Grant a role carrying ViewChannel; the live socket must be subscribed.
	makeModerator(h, owner, member, serverID, permissions.ViewChannel, "viewer")
	ws.Drain(500 * time.Millisecond)

	_ = postTextMessage(h, owner, channelID, "now visible")
	if n := ws.CountEvents("MESSAGE_CREATE", 700*time.Millisecond); n == 0 {
		t.Fatal("member should receive messages after being granted ViewChannel")
	}
}

// TestDeleteRequiresViewChannel: deleting an own message in a channel the member
// can no longer view must be rejected.
func TestDeleteRequiresViewChannel(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	keep := sendMessage(h, member, channelID, "to survive")
	gone := sendMessage(h, member, channelID, "to delete as control")

	// Control: the author can delete while they can view the channel.
	if code := deleteMessage(h, member, channelID, gone); code != http.StatusOK {
		t.Fatalf("author delete with ViewChannel: expected 200, got %d", code)
	}

	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages|permissions.CreateInvites|permissions.AttachFiles); code != http.StatusOK {
		t.Fatalf("strip ViewChannel: got %d", code)
	}
	if code := deleteMessage(h, member, channelID, keep); code != http.StatusForbidden {
		t.Fatalf("author delete without ViewChannel: expected 403, got %d", code)
	}
}

// TestPinRequiresViewChannel: a moderator with ManageMessages but no ViewChannel
// must not be able to pin or unpin messages in a hidden channel.
func TestPinRequiresViewChannel(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	msgID := sendMessage(h, owner, channelID, "pin target")

	// Give the member ManageMessages via a custom role, then strip ViewChannel from
	// the default role so their only remaining perms lack ViewChannel.
	makeModerator(h, owner, member, serverID, permissions.ManageMessages, "mod")
	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages|permissions.CreateInvites|permissions.AttachFiles); code != http.StatusOK {
		t.Fatalf("strip ViewChannel: got %d", code)
	}

	if code := pinMessage(h, member, channelID, msgID); code != http.StatusForbidden {
		t.Fatalf("pin without ViewChannel: expected 403, got %d", code)
	}
	if code := unpinMessage(h, member, channelID, msgID); code != http.StatusForbidden {
		t.Fatalf("unpin without ViewChannel: expected 403, got %d", code)
	}

	// The owner (privileged) can still pin, proving the route itself works.
	if code := pinMessage(h, owner, channelID, msgID); code != http.StatusOK {
		t.Fatalf("owner pin: expected 200, got %d", code)
	}
}

// TestAckRejectsOutsiderAndCrossChannel: the ack route must not let a non-member
// record read state against a hidden channel, nor accept a message from a
// different channel.
func TestAckRejectsOutsiderAndCrossChannel(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	outsider := h.Register("outsider")
	serverID := h.CreateServer(owner, "S")
	chA := h.CreateChannel(owner, serverID, "a")
	chB := h.CreateChannel(owner, serverID, "b")
	joinServer(h, owner, member, serverID)

	msgA := sendMessage(h, owner, chA, "in channel a")

	// Control: a member can ack a message in the channel it belongs to.
	if code := ackChannel(h, member, chA, msgA); code != http.StatusOK {
		t.Fatalf("member ack own channel: expected 200, got %d", code)
	}

	// Outsider (not a server member) cannot ack the channel at all.
	if code := ackChannel(h, outsider, chA, msgA); code != http.StatusForbidden {
		t.Fatalf("outsider ack: expected 403, got %d", code)
	}

	// Cross-channel: msgA does not belong to chB, so acking chB with it is rejected.
	if code := ackChannel(h, member, chB, msgA); code != http.StatusNotFound {
		t.Fatalf("cross-channel ack: expected 404, got %d", code)
	}
}

// TestReadStateListHidesRevokedChannels: after losing ViewChannel, a channel must
// drop out of the read-state listing (it otherwise leaks the channel ID and
// mention state).
func TestReadStateListHidesRevokedChannels(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	msgID := sendMessage(h, owner, channelID, "ack me")
	if code := ackChannel(h, member, channelID, msgID); code != http.StatusOK {
		t.Fatalf("member ack: expected 200, got %d", code)
	}

	// Control: the channel appears in the member's read states.
	found := false
	for _, id := range readStateChannelIDs(h, member) {
		if id == channelID {
			found = true
		}
	}
	if !found {
		t.Fatal("acked channel should appear in read states")
	}

	// Strip ViewChannel — the read state for the hidden channel must not be listed.
	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages|permissions.CreateInvites|permissions.AttachFiles); code != http.StatusOK {
		t.Fatalf("strip ViewChannel: got %d", code)
	}
	for _, id := range readStateChannelIDs(h, member) {
		if id == channelID {
			t.Fatal("read-state listing leaked a hidden channel")
		}
	}
}
