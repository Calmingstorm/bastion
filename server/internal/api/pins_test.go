package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// rawPin pins over a bare HTTP client, safe to call from a goroutine.
func rawPin(h *testutil.Harness, u *testutil.TestUser, channelID, messageID string) int {
	req, err := http.NewRequest(http.MethodPut,
		h.URL("/api/v1/channels/"+channelID+"/pins/"+messageID), nil)
	if err != nil {
		return -1
	}
	req.Header.Set("Authorization", "Bearer "+u.AccessToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return -1
	}
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode
}

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

// TestPinSerializesPerChannel: pinning takes a per-channel advisory lock so the
// cap check and insert cannot be raced across concurrent statements (an
// in-statement COUNT alone does not serialize). Deterministically: while the
// test holds that lock, a pin blocks; once released, it completes. Removing the
// handler's lock makes the pin no longer block.
func TestPinSerializesPerChannel(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	msgID := sendMessage(h, owner, channelID, "pin me")
	ctx := context.Background()

	conn, err := h.Pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire conn: %v", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtext($1))`, channelID); err != nil {
		t.Fatalf("hold channel lock: %v", err)
	}

	done := make(chan int, 1)
	go func() { done <- rawPin(h, owner, channelID, msgID) }()

	select {
	case <-done:
		_, _ = conn.Exec(ctx, `SELECT pg_advisory_unlock(hashtext($1))`, channelID)
		t.Fatal("pin should block on the per-channel advisory lock, but returned immediately")
	case <-time.After(500 * time.Millisecond):
		// Blocked as expected.
	}

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_unlock(hashtext($1))`, channelID); err != nil {
		t.Fatalf("release channel lock: %v", err)
	}
	if code := <-done; code != http.StatusOK {
		t.Fatalf("pin after lock release: expected 200, got %d", code)
	}
}

// TestUnpinBroadcastsOnlyWhenRemoved: a real unpin broadcasts MESSAGE_UNPIN once;
// a repeated no-op unpin returns 200 without a second broadcast.
func TestUnpinBroadcastsOnlyWhenRemoved(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	msgID := sendMessage(h, owner, channelID, "pin me")
	if code := pinMessage(h, owner, channelID, msgID); code != http.StatusOK {
		t.Fatalf("pin: expected 200, got %d", code)
	}

	ws := h.DialWS(owner)
	if code := unpinMessage(h, owner, channelID, msgID); code != http.StatusOK {
		t.Fatalf("unpin: expected 200, got %d", code)
	}
	if n := ws.CountEvents("MESSAGE_UNPIN", 700*time.Millisecond); n != 1 {
		t.Fatalf("a real unpin should broadcast once, got %d", n)
	}
	if code := unpinMessage(h, owner, channelID, msgID); code != http.StatusOK {
		t.Fatalf("re-unpin: expected 200 (idempotent), got %d", code)
	}
	if n := ws.CountEvents("MESSAGE_UNPIN", 500*time.Millisecond); n != 0 {
		t.Fatalf("a no-op unpin must not broadcast, got %d", n)
	}
}
