package api_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// TestMigration013ClassifiesDMsConservatively runs the real migration and asserts
// it records provenance without inferring history: 3+ member DMs become 'group',
// every legacy two-member DM (single or duplicate) becomes 'legacy_unknown' and
// is left intact and unkeyed -- no automatic merge -- while the direct-key unique
// invariant and CHECK equivalence are installed. Down fully reverses.
func TestMigration013ClassifiesDMsConservatively(t *testing.T) {
	dsn := testutil.NewMigrationDB(t)
	m := newMigrator(t, dsn)
	if err := m.Migrate(12); err != nil {
		t.Fatalf("migrate to v12: %v", err)
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	exec := func(q string, args ...any) {
		if _, err := pool.Exec(ctx, q, args...); err != nil {
			t.Fatalf("seed (%s): %v", q, err)
		}
	}
	ua, ub, uc, ud, ue := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, u := range []string{ua, ub, uc, ud, ue} {
		exec(`INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, '')`,
			u, "u"+uuid.NewString()[:8], u+"@x")
	}
	lo, hi := ua, ub
	if lo > hi {
		lo, hi = hi, lo
	}

	// A group DM (A,B,C), two duplicate direct DMs (A,B), and a lone direct (D,E).
	chG, ch1, ch2, ch3 := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, id := range []string{chG, ch1, ch2, ch3} {
		exec(`INSERT INTO channels (id, name, type) VALUES ($1, 'DM', 'dm')`, id)
	}
	exec(`INSERT INTO dm_members (channel_id, user_id) VALUES ($1,$2),($1,$3),($1,$4)`, chG, ua, ub, uc)
	exec(`INSERT INTO dm_members (channel_id, user_id) VALUES ($1,$2),($1,$3)`, ch1, ua, ub)
	exec(`INSERT INTO dm_members (channel_id, user_id) VALUES ($1,$2),($1,$3)`, ch2, ua, ub)
	exec(`INSERT INTO dm_members (channel_id, user_id) VALUES ($1,$2),($1,$3)`, ch3, ud, ue)
	// A message on each duplicate, to prove neither is emptied or moved.
	m1, m2 := uuid.NewString(), uuid.NewString()
	exec(`INSERT INTO messages (id, channel_id, author_id, content) VALUES ($1,$2,$3,'one')`, m1, ch1, ua)
	exec(`INSERT INTO messages (id, channel_id, author_id, content) VALUES ($1,$2,$3,'two')`, m2, ch2, ub)

	if err := m.Migrate(13); err != nil {
		t.Fatalf("migrate to v13: %v", err)
	}

	kind := func(id string) string {
		var k *string
		if err := pool.QueryRow(ctx, `SELECT dm_kind FROM channels WHERE id = $1`, id).Scan(&k); err != nil {
			t.Fatalf("read dm_kind (%s): %v", id, err)
		}
		if k == nil {
			return "<null>"
		}
		return *k
	}
	// Provenance.
	if got := kind(chG); got != "group" {
		t.Fatalf("3-member DM should be group, got %q", got)
	}
	for _, id := range []string{ch1, ch2, ch3} {
		if got := kind(id); got != "legacy_unknown" {
			t.Fatalf("legacy 2-member DM should be legacy_unknown, got %q", got)
		}
	}
	// No merge: both duplicates and their messages survive on their own channels.
	for id, msg := range map[string]string{ch1: m1, ch2: m2} {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM messages WHERE channel_id = $1 AND id = $2`, id, msg).Scan(&n); err != nil || n != 1 {
			t.Fatalf("duplicate %s must keep its own message, got %d (err=%v)", id, n, err)
		}
	}
	// Nothing is keyed by the migration.
	var keyed int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM channels WHERE dm_user_lo IS NOT NULL`).Scan(&keyed); err != nil || keyed != 0 {
		t.Fatalf("migration must key nothing, got %d keyed (err=%v)", keyed, err)
	}
	// The unique invariant applies to keyed direct rows.
	exec(`INSERT INTO channels (name, type, dm_kind, dm_user_lo, dm_user_hi) VALUES ('DM','dm','direct',$1,$2)`, lo, hi)
	if _, err := pool.Exec(ctx,
		`INSERT INTO channels (name, type, dm_kind, dm_user_lo, dm_user_hi) VALUES ('DM','dm','direct',$1,$2)`, lo, hi); err == nil {
		t.Fatal("a second keyed direct channel for the same pair must violate the unique index")
	}
	// CHECK equivalence: direct requires keys; legacy_unknown forbids them.
	if _, err := pool.Exec(ctx,
		`INSERT INTO channels (name, type, dm_kind) VALUES ('DM','dm','direct')`); err == nil {
		t.Fatal("a direct channel without a key must violate the CHECK")
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO channels (name, type, dm_kind, dm_user_lo, dm_user_hi) VALUES ('DM','dm','legacy_unknown',$1,$2)`, lo, hi); err == nil {
		t.Fatal("a legacy_unknown channel with a key must violate the CHECK")
	}

	// Down fully reverses; the duplicate channels are untouched throughout.
	if err := m.Migrate(12); err != nil {
		t.Fatalf("migrate down to v12: %v", err)
	}
	if columnExists(t, pool, "channels", "dm_kind") || columnExists(t, pool, "channels", "dm_user_lo") {
		t.Fatal("down migration should drop the dm columns")
	}
	var survivors int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM channels WHERE id = ANY($1)`, []string{ch1, ch2}).Scan(&survivors); err != nil || survivors != 2 {
		t.Fatalf("both duplicate channels must survive, got %d (err=%v)", survivors, err)
	}
}
