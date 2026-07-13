package api_test

import (
	"context"
	"testing"
	"time"

	"github.com/Calmingstorm/bastion/server/internal/realtime"
	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// TestWSPingRefreshesAndRestoresPresence: a transport ping must (a) refresh an
// existing custom status's TTL WITHOUT clobbering the value back to online, and
// (b) restore a key that vanished while the socket stayed connected. A bare
// EXPIRE fails (b); a SET/SetOnline fails (a).
func TestWSPingRefreshesAndRestoresPresence(t *testing.T) {
	old := realtime.PingInterval
	realtime.PingInterval = 40 * time.Millisecond
	t.Cleanup(func() { realtime.PingInterval = old })

	h := testutil.New(t)
	owner := h.Register("owner")
	ctx := context.Background()
	key := "presence:" + owner.ID

	ws := h.DialWS(owner)
	_ = ws

	waitVal := func(want string) bool {
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if h.RDB.Get(ctx, key).Val() == want {
				return true
			}
			time.Sleep(20 * time.Millisecond)
		}
		return false
	}

	if !waitVal("online") {
		t.Fatal("presence never went online on connect")
	}

	// A custom status with a short TTL: pings must refresh that TTL (so the value
	// survives well past the short TTL) while preserving "away", not clobbering
	// it to online.
	if err := h.RDB.Set(ctx, key, "away", 300*time.Millisecond).Err(); err != nil {
		t.Fatalf("set away: %v", err)
	}
	time.Sleep(600 * time.Millisecond) // several 40ms ping cycles, past the TTL
	if got := h.RDB.Get(ctx, key).Val(); got != "away" {
		t.Fatalf("ping must refresh a custom status without clobbering it, got %q", got)
	}

	// After the key vanishes, a ping restores the default online status.
	if err := h.RDB.Del(ctx, key).Err(); err != nil {
		t.Fatalf("delete presence: %v", err)
	}
	if !waitVal("online") {
		t.Fatal("ping-driven refresh did not restore vanished presence")
	}
}
