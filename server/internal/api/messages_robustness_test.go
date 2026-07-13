package api_test

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/Calmingstorm/bastion/server/internal/api"
	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// TestListCursorStatuses: a missing message-list cursor is a 400, but a real DB
// error during the cursor lookup is a 500 (it was previously a misleading 400).
func TestListCursorStatuses(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	bad := uuid.NewString()
	if code := h.Request(http.MethodGet,
		"/api/v1/channels/"+channelID+"/messages?before="+bad, owner.AccessToken, nil, nil); code != http.StatusBadRequest {
		t.Fatalf("a missing cursor should be 400, got %d", code)
	}

	msgID := sendMessage(h, owner, channelID, "cursor")
	if _, err := h.Pool.Exec(context.Background(),
		`ALTER TABLE messages DROP COLUMN created_at CASCADE`); err != nil {
		t.Fatalf("break cursor lookup: %v", err)
	}
	if code := h.Request(http.MethodGet,
		"/api/v1/channels/"+channelID+"/messages?before="+msgID, owner.AccessToken, nil, nil); code != http.StatusInternalServerError {
		t.Fatalf("a DB error during the cursor lookup should be 500, got %d", code)
	}
}

// TestEditRowVanishedReturns404: if a message is deleted between an edit's author
// check and its UPDATE ... RETURNING, the edit returns 404 (not 500) and does not
// broadcast MESSAGE_UPDATE.
func TestEditRowVanishedReturns404(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	msgID := sendMessage(h, owner, channelID, "original")

	ws := h.DialWS(owner)

	var once sync.Once
	api.BeforeEditUpdateForTest = func() {
		once.Do(func() {
			if _, err := h.Pool.Exec(context.Background(), `DELETE FROM messages WHERE id = $1`, msgID); err != nil {
				t.Errorf("delete message: %v", err)
			}
		})
	}
	t.Cleanup(func() { api.BeforeEditUpdateForTest = nil })

	if code := editMessage(h, owner, channelID, msgID, "edited"); code != http.StatusNotFound {
		t.Fatalf("editing a vanished message should be 404, got %d", code)
	}
	if n := ws.CountEvents("MESSAGE_UPDATE", 500*time.Millisecond); n != 0 {
		t.Fatalf("a failed edit must not broadcast MESSAGE_UPDATE, got %d", n)
	}
}
