package presence_test

import (
	"context"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/Calmingstorm/bastion/server/internal/presence"
	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// TestHeartbeatSetsThenRefreshesWithoutClobbering: a heartbeat for an unknown
// user sets them online with a TTL, and a heartbeat for a known user refreshes
// the TTL without overwriting a custom status.
func TestHeartbeatSetsThenRefreshesWithoutClobbering(t *testing.T) {
	h := testutil.New(t)
	svc := presence.NewService(h.RDB)
	ctx := context.Background()
	uid := uuid.New()

	svc.Heartbeat(ctx, uid)
	if got := svc.GetPresence(ctx, uid); got != "online" {
		t.Fatalf("heartbeat on a missing key should set online, got %q", got)
	}
	ttl, err := h.RDB.TTL(ctx, "presence:"+uid.String()).Result()
	if err != nil || ttl <= 0 {
		t.Fatalf("expected a positive TTL, got %v (err=%v)", ttl, err)
	}

	svc.SetStatus(ctx, uid, "away")
	svc.Heartbeat(ctx, uid)
	if got := svc.GetPresence(ctx, uid); got != "away" {
		t.Fatalf("heartbeat must refresh, not clobber, a custom status; got %q", got)
	}
}

// TestGetPresenceBatch: returns the status of online users and "offline" for
// users with no presence key, without panicking on a missing value.
func TestGetPresenceBatch(t *testing.T) {
	h := testutil.New(t)
	svc := presence.NewService(h.RDB)
	ctx := context.Background()
	online := uuid.New()
	offline := uuid.New()
	svc.SetOnline(ctx, online)

	got := svc.GetPresenceBatch(ctx, []uuid.UUID{online, offline})
	if got[online] != "online" {
		t.Fatalf("online user should be online, got %q", got[online])
	}
	if got[offline] != "offline" {
		t.Fatalf("unset user should be offline, got %q", got[offline])
	}
}

// TestHeartbeatMissPathDoesNotClobberConcurrentStatus: on the miss path (key
// absent), a status written between the EXPIRE and the SET must survive -- the
// SET NX must not overwrite it back to online.
func TestHeartbeatMissPathDoesNotClobberConcurrentStatus(t *testing.T) {
	h := testutil.New(t)
	svc := presence.NewService(h.RDB)
	ctx := context.Background()
	uid := uuid.New()

	var once sync.Once
	presence.AfterHeartbeatExpireForTest = func() {
		once.Do(func() { svc.SetStatus(ctx, uid, "away") })
	}
	t.Cleanup(func() { presence.AfterHeartbeatExpireForTest = nil })

	svc.Heartbeat(ctx, uid) // key missing -> seam sets away -> SET NX must no-op
	if got := svc.GetPresence(ctx, uid); got != "away" {
		t.Fatalf("heartbeat miss path must not clobber a concurrently-set status, got %q", got)
	}
}

// TestGetPresenceBatchToleratesNonString: a non-string value from MGET must
// decode to "offline" rather than panic on a type assertion.
func TestGetPresenceBatchToleratesNonString(t *testing.T) {
	h := testutil.New(t)
	svc := presence.NewService(h.RDB)
	ctx := context.Background()
	uid := uuid.New()

	presence.MGetForTest = func(ctx context.Context, keys []string) ([]interface{}, error) {
		return []interface{}{int64(42)}, nil
	}
	t.Cleanup(func() { presence.MGetForTest = nil })

	got := svc.GetPresenceBatch(ctx, []uuid.UUID{uid})
	if got[uid] != "offline" {
		t.Fatalf("a non-string presence value must decode to offline, got %q", got[uid])
	}
}
