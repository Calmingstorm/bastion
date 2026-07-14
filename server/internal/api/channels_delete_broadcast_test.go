package api_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/Calmingstorm/bastion/server/internal/testutil"
	"github.com/google/uuid"
)

// TestChannelDeleteBroadcastsOnlyAfterCommit: CHANNEL_DELETE must be broadcast
// AFTER the row is deleted, never before. Broadcasting first had two failure
// modes: a fetch racing the broadcast-to-commit window could read the channel
// back into existence on clients, and a delete that failed after broadcasting
// left every connected client having removed a channel that still exists, with
// no correcting event ever coming. The observable contract: a delete that does
// not delete (404 here) emits NO event; a successful delete emits exactly one.
func TestChannelDeleteBroadcastsOnlyAfterCommit(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	doomedID := h.CreateChannel(owner, serverID, "doomed")

	ws := h.DialWS(owner)
	ws.Drain(400 * time.Millisecond) // discard connect/presence/join noise

	// A delete that fails (unknown channel id) must broadcast nothing.
	missing := uuid.NewString()
	if code := h.Request(http.MethodDelete,
		"/api/v1/servers/"+serverID+"/channels/"+missing, owner.AccessToken, nil, nil); code != http.StatusNotFound {
		t.Fatalf("deleting a missing channel: expected 404, got %d", code)
	}
	if n := ws.CountEvents("CHANNEL_DELETE", 600*time.Millisecond); n != 0 {
		t.Fatalf("a failed delete must not broadcast CHANNEL_DELETE, got %d", n)
	}

	// A successful delete broadcasts exactly once.
	if code := h.Request(http.MethodDelete,
		"/api/v1/servers/"+serverID+"/channels/"+doomedID, owner.AccessToken, nil, nil); code != http.StatusOK {
		t.Fatalf("deleting an existing channel: expected 200, got %d", code)
	}
	if n := ws.CountEvents("CHANNEL_DELETE", 800*time.Millisecond); n != 1 {
		t.Fatalf("a successful delete should broadcast exactly once, got %d", n)
	}
}

// TestChannelDeleteFanoutOncePerMember: server-scoped events are delivered per
// MEMBER, not per channel. Channel fanout had two reproducible failures once
// deletes broadcast after commit: a member subscribed to several surviving
// channels received duplicate CHANNEL_DELETE events, and a client subscribed
// only to the deleted channel received none (the fanout targets were queried
// after the row was gone).
func TestChannelDeleteFanoutOncePerMember(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	// Several surviving channels: per-channel fanout would deliver one event
	// per survivor to the same member.
	h.CreateChannel(owner, serverID, "alpha")
	h.CreateChannel(owner, serverID, "beta")
	doomedID := h.CreateChannel(owner, serverID, "doomed")

	ws := h.DialWS(owner)
	ws.Drain(400 * time.Millisecond)

	if code := h.Request(http.MethodDelete,
		"/api/v1/servers/"+serverID+"/channels/"+doomedID, owner.AccessToken, nil, nil); code != http.StatusOK {
		t.Fatalf("delete: expected 200, got %d", code)
	}
	if n := ws.CountEvents("CHANNEL_DELETE", 800*time.Millisecond); n != 1 {
		t.Fatalf("a member must receive CHANNEL_DELETE exactly once regardless of channel count, got %d", n)
	}
}

// TestMentionNotificationCarriesCreatedAt: the NOTIFICATION payload carries the
// message's server-minted createdAt, so clients can drop a DELAYED notification
// whose message an acknowledgment already covered (client and server clocks are
// never compared -- without this field the delayed-notification flag
// resurrection is unfixable client-side on this event).
func TestMentionNotificationCarriesCreatedAt(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	if code := postTextMessage(h, owner, channelID, "@member ping"); code != http.StatusCreated {
		t.Fatalf("mention: expected 201, got %d", code)
	}
	evs := ws.MatchingEvents("NOTIFICATION", 800*time.Millisecond)
	if len(evs) == 0 {
		t.Fatal("mention should deliver a NOTIFICATION")
	}
	var ev struct {
		Data struct {
			CreatedAt string `json:"createdAt"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(evs[0]), &ev); err != nil {
		t.Fatalf("unmarshal notification: %v", err)
	}
	if ev.Data.CreatedAt == "" {
		t.Fatal("NOTIFICATION must carry the server-minted createdAt")
	}
	if _, err := time.Parse(time.RFC3339Nano, ev.Data.CreatedAt); err != nil {
		t.Fatalf("createdAt must be RFC3339: %v", err)
	}
}
