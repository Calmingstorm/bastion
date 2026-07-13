package api_test

import (
	"context"
	"testing"
	"time"

	"github.com/Calmingstorm/bastion/server/internal/realtime"
	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// TestWSPingRestoresPresence: if a connected client's presence key expires while
// its socket stays open, the transport-ping-driven refresh restores it. A bare
// EXPIRE (the previous behavior) could not bring an absent key back.
func TestWSPingRestoresPresence(t *testing.T) {
	old := realtime.PingInterval
	realtime.PingInterval = 40 * time.Millisecond
	t.Cleanup(func() { realtime.PingInterval = old })

	h := testutil.New(t)
	owner := h.Register("owner")
	ctx := context.Background()
	key := "presence:" + owner.ID

	ws := h.DialWS(owner)
	_ = ws

	waitOnline := func() bool {
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if h.RDB.Get(ctx, key).Val() == "online" {
				return true
			}
			time.Sleep(20 * time.Millisecond)
		}
		return false
	}

	// Wait for the connect-time set to land, so the delete actually removes the
	// key instead of racing ahead of it.
	if !waitOnline() {
		t.Fatal("presence never went online on connect")
	}
	if err := h.RDB.Del(ctx, key).Err(); err != nil {
		t.Fatalf("delete presence: %v", err)
	}
	// A transport ping must bring the vanished key back.
	if !waitOnline() {
		t.Fatal("ping-driven refresh did not restore presence")
	}
}
