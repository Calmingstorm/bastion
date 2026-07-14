package api_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/Calmingstorm/bastion/server/internal/permissions"
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

// TestChannelEventsOnlyToAuthorizedMembers: channel events go to the
// deduplicated AUTHORIZED recipient set, not raw membership. A member whose
// ViewChannel was revoked must receive no CHANNEL_CREATE/UPDATE/DELETE --
// create and update payloads carry channel metadata that would otherwise leak,
// and a create would install the hidden channel into client state. The delete's
// recipient set is captured before the row is removed.
func TestChannelEventsOnlyToAuthorizedMembers(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	hidden := h.Register("hidden")
	serverID := h.CreateServer(owner, "S")
	joinServer(h, owner, hidden, serverID)

	// Revoke visibility for ordinary members (the owner sees everything).
	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages); code != http.StatusOK {
		t.Fatalf("strip ViewChannel: got %d", code)
	}

	wsOwner := h.DialWS(owner)
	wsHidden := h.DialWS(hidden)
	wsOwner.Drain(400 * time.Millisecond)
	wsHidden.Drain(400 * time.Millisecond)

	// Act-then-assert per event: CountEvents drains the socket's event queue,
	// so each window must contain only its own event.
	chID := h.CreateChannel(owner, serverID, "secret")
	if n := wsOwner.CountEvents("CHANNEL_CREATE", 700*time.Millisecond); n != 1 {
		t.Fatalf("owner should receive CHANNEL_CREATE exactly once, got %d", n)
	}
	if n := wsHidden.CountEvents("CHANNEL_CREATE", 400*time.Millisecond); n != 0 {
		t.Fatalf("a member without ViewChannel must receive no CHANNEL_CREATE, got %d", n)
	}

	if code := h.Request(http.MethodPatch,
		"/api/v1/servers/"+serverID+"/channels/"+chID, owner.AccessToken,
		map[string]string{"name": "renamed"}, nil); code != http.StatusOK {
		t.Fatalf("update channel: got %d", code)
	}
	if n := wsOwner.CountEvents("CHANNEL_UPDATE", 700*time.Millisecond); n != 1 {
		t.Fatalf("owner should receive CHANNEL_UPDATE exactly once, got %d", n)
	}
	if n := wsHidden.CountEvents("CHANNEL_UPDATE", 400*time.Millisecond); n != 0 {
		t.Fatalf("a member without ViewChannel must receive no CHANNEL_UPDATE, got %d", n)
	}

	if code := h.Request(http.MethodDelete,
		"/api/v1/servers/"+serverID+"/channels/"+chID, owner.AccessToken, nil, nil); code != http.StatusOK {
		t.Fatalf("delete channel: got %d", code)
	}
	if n := wsOwner.CountEvents("CHANNEL_DELETE", 700*time.Millisecond); n != 1 {
		t.Fatalf("owner should receive CHANNEL_DELETE exactly once, got %d", n)
	}
	if n := wsHidden.CountEvents("CHANNEL_DELETE", 400*time.Millisecond); n != 0 {
		t.Fatalf("a member without ViewChannel must receive no CHANNEL_DELETE, got %d", n)
	}
}

// TestBackdatedBotMentionNotifiesWithEmissionTime: bots may backdate a
// message's createdAt (a presentation timestamp), so it is NOT a causal
// watermark -- unread reconciliation compares the notification's time against
// lastReadAt, and treating a backdated mention as pre-acknowledgment would
// silently swallow a genuinely new event. The NOTIFICATION must carry the
// server's own emission time.
func TestBackdatedBotMentionNotifiesWithEmissionTime(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)
	_, _, botToken := createBotFull(t, h, owner, serverID)

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	before := time.Now().UTC().Add(-2 * time.Second)
	backdated := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	if code := h.RequestAuth(http.MethodPost,
		"/api/v1/channels/"+channelID+"/messages", "Bot "+botToken,
		map[string]any{"content": "@member ping", "createdAt": backdated}, nil); code != http.StatusCreated {
		t.Fatalf("backdated bot mention: expected 201, got %d", code)
	}
	evs := ws.MatchingEvents("NOTIFICATION", 900*time.Millisecond)
	if len(evs) == 0 {
		t.Fatal("mention should deliver a NOTIFICATION")
	}
	var ev struct {
		Data struct {
			CreatedAt time.Time `json:"createdAt"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(evs[0]), &ev); err != nil {
		t.Fatalf("unmarshal notification: %v", err)
	}
	if !ev.Data.CreatedAt.After(before) {
		t.Fatalf("notification must carry the EMISSION time, got backdated %s", ev.Data.CreatedAt)
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
