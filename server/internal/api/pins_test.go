package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// TestPinBroadcastsOnlyOnNewPin: pinning an already-pinned message is idempotent
// and must not emit a second MESSAGE_PIN (the broadcast previously fired even
// when ON CONFLICT DO NOTHING inserted nothing).
func TestPinBroadcastsOnlyOnNewPin(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	msgID := sendMessage(h, owner, channelID, "pin me")

	ws := h.DialWS(owner)

	if code := pinMessage(h, owner, channelID, msgID); code != http.StatusOK {
		t.Fatalf("first pin: expected 200, got %d", code)
	}
	if n := ws.CountEvents("MESSAGE_PIN", 700*time.Millisecond); n != 1 {
		t.Fatalf("a new pin should broadcast exactly once, got %d", n)
	}
	if code := pinMessage(h, owner, channelID, msgID); code != http.StatusOK {
		t.Fatalf("re-pin: expected 200 (idempotent), got %d", code)
	}
	if n := ws.CountEvents("MESSAGE_PIN", 500*time.Millisecond); n != 0 {
		t.Fatalf("re-pinning must not broadcast again, got %d", n)
	}
}

// TestPinCapEnforced: a channel accepts at most 50 pins.
func TestPinCapEnforced(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	// Seed 50 pinned messages directly (fast, and avoids the message rate limit).
	ctx := context.Background()
	if _, err := h.Pool.Exec(ctx,
		`WITH m AS (
			INSERT INTO messages (channel_id, author_id, content)
			SELECT $1, $2, 'm' FROM generate_series(1, 50)
			RETURNING id
		)
		INSERT INTO message_pins (channel_id, message_id, pinned_by)
		SELECT $1, id, $2 FROM m`,
		channelID, owner.ID); err != nil {
		t.Fatalf("seed pins: %v", err)
	}

	var over string
	if err := h.Pool.QueryRow(ctx,
		`INSERT INTO messages (channel_id, author_id, content) VALUES ($1, $2, 'over') RETURNING id`,
		channelID, owner.ID).Scan(&over); err != nil {
		t.Fatalf("seed message: %v", err)
	}
	if code := pinMessage(h, owner, channelID, over); code != http.StatusBadRequest {
		t.Fatalf("51st pin: expected 400, got %d", code)
	}
}
