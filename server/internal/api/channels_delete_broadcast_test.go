package api_test

import (
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
