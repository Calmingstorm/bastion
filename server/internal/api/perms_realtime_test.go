package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/Calmingstorm/bastion/server/internal/permissions"
	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// TestKickUnsubscribesLiveSocket: a kicked member's already-connected socket must
// stop receiving the former server's channel events.
func TestKickUnsubscribesLiveSocket(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	// Control: a member receives channel messages.
	_ = postTextMessage(h, owner, channelID, "before kick")
	if n := ws.CountEvents("MESSAGE_CREATE", 700*time.Millisecond); n == 0 {
		t.Fatal("member should receive messages before being kicked")
	}

	if code := kickMember(h, owner, serverID, member.ID); code != http.StatusOK {
		t.Fatalf("kick: expected 200, got %d", code)
	}
	ws.Drain(200 * time.Millisecond)

	_ = postTextMessage(h, owner, channelID, "after kick")
	if n := ws.CountEvents("MESSAGE_CREATE", 700*time.Millisecond); n != 0 {
		t.Fatalf("kicked member received %d MESSAGE_CREATE, want 0", n)
	}
}

// TestBanUnsubscribesLiveSocket: banning likewise severs live delivery.
func TestBanUnsubscribesLiveSocket(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	_ = postTextMessage(h, owner, channelID, "before ban")
	if n := ws.CountEvents("MESSAGE_CREATE", 700*time.Millisecond); n == 0 {
		t.Fatal("member should receive messages before being banned")
	}

	if code := banMember(h, owner, serverID, member.ID); code != http.StatusOK {
		t.Fatalf("ban: expected 200, got %d", code)
	}
	ws.Drain(200 * time.Millisecond)

	_ = postTextMessage(h, owner, channelID, "after ban")
	if n := ws.CountEvents("MESSAGE_CREATE", 700*time.Millisecond); n != 0 {
		t.Fatalf("banned member received %d MESSAGE_CREATE, want 0", n)
	}
}

// TestTypingDeliveredToChannel: the positive control — a member who can post in a
// channel has their TYPING_START delivered to the channel's subscribers.
func TestTypingDeliveredToChannel(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	ownerWS := h.DialWS(owner)
	ownerWS.Drain(400 * time.Millisecond)

	memberWS := h.DialWS(member)
	memberWS.Drain(200 * time.Millisecond)
	memberWS.Send("TYPING_START", map[string]string{"channelId": channelID})

	if n := ownerWS.CountEvents("TYPING_START", 700*time.Millisecond); n == 0 {
		t.Fatal("owner should receive a typing indicator from a permitted member")
	}
}

// TestTypingBlockedWithoutViewChannel: a member who lost ViewChannel cannot leak a
// typing indicator into the now-hidden channel.
func TestTypingBlockedWithoutViewChannel(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages|permissions.CreateInvites|permissions.AttachFiles); code != http.StatusOK {
		t.Fatalf("strip ViewChannel: got %d", code)
	}

	ownerWS := h.DialWS(owner)
	ownerWS.Drain(400 * time.Millisecond)

	memberWS := h.DialWS(member)
	memberWS.Drain(200 * time.Millisecond)
	memberWS.Send("TYPING_START", map[string]string{"channelId": channelID})

	if n := ownerWS.CountEvents("TYPING_START", 700*time.Millisecond); n != 0 {
		t.Fatalf("owner received %d typing events from a member without ViewChannel, want 0", n)
	}
}

// TestTypingBlockedWithoutSendMessages: typing means "composing to send", so a
// read-only member (ViewChannel but not SendMessages) does not emit it either.
func TestTypingBlockedWithoutSendMessages(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.ViewChannel|permissions.CreateInvites|permissions.AttachFiles); code != http.StatusOK {
		t.Fatalf("strip SendMessages: got %d", code)
	}

	ownerWS := h.DialWS(owner)
	ownerWS.Drain(400 * time.Millisecond)

	memberWS := h.DialWS(member)
	memberWS.Drain(200 * time.Millisecond)
	memberWS.Send("TYPING_START", map[string]string{"channelId": channelID})

	if n := ownerWS.CountEvents("TYPING_START", 700*time.Millisecond); n != 0 {
		t.Fatalf("owner received %d typing events from a read-only member, want 0", n)
	}
}

// TestTypingBlockedForOutsider: a non-member who knows the channel UUID cannot
// inject a typing indicator into it.
func TestTypingBlockedForOutsider(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	outsider := h.Register("outsider")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	ownerWS := h.DialWS(owner)
	ownerWS.Drain(400 * time.Millisecond)

	outsiderWS := h.DialWS(outsider)
	outsiderWS.Drain(200 * time.Millisecond)
	outsiderWS.Send("TYPING_START", map[string]string{"channelId": channelID})

	if n := ownerWS.CountEvents("TYPING_START", 700*time.Millisecond); n != 0 {
		t.Fatalf("owner received %d typing events from an outsider, want 0", n)
	}
}
