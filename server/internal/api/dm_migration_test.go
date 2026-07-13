package api_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// TestMigration013DeduplicatesDirectDMs runs the real migration against a seeded
// pair of duplicate 1:1 DMs (messages, attachment, reaction, pin, read-states,
// and open/closed memberships on both) and asserts everything merges into the
// oldest channel without loss -- while a group DM stays unkeyed and a lone direct
// DM gets keyed. It then verifies the unique invariant and the down migration.
func TestMigration013DeduplicatesDirectDMs(t *testing.T) {
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
	// Five users; A<B is enforced below so the canonical pair is deterministic.
	ua, ub, uc, ud, ue := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for i, u := range []string{ua, ub, uc, ud, ue} {
		exec(`INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, '')`,
			u, "u"+uuid.NewString()[:8], u+"@x")
		_ = i
	}
	lo, hi := ua, ub
	if lo > hi {
		lo, hi = hi, lo
	}

	// Two duplicate direct DMs for (A,B): ch1 older (the winner), ch2 newer.
	ch1, ch2, ch3, chG := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	exec(`INSERT INTO channels (id, name, type, created_at) VALUES ($1, 'DM', 'dm', '2020-01-01')`, ch1)
	exec(`INSERT INTO channels (id, name, type, created_at) VALUES ($1, 'DM', 'dm', '2020-06-01')`, ch2)
	exec(`INSERT INTO channels (id, name, type, created_at) VALUES ($1, 'DM', 'dm', '2020-01-01')`, ch3)
	exec(`INSERT INTO channels (id, name, type, created_at) VALUES ($1, 'DM', 'dm', '2020-01-01')`, chG)

	// dm_members with mixed open/closed state across the duplicates.
	exec(`INSERT INTO dm_members (channel_id, user_id, closed_at) VALUES ($1, $2, '2021-01-01')`, ch1, ua) // A closed on ch1
	exec(`INSERT INTO dm_members (channel_id, user_id, closed_at) VALUES ($1, $2, NULL)`, ch1, ub)         // B open on ch1
	exec(`INSERT INTO dm_members (channel_id, user_id, closed_at) VALUES ($1, $2, NULL)`, ch2, ua)         // A open on ch2
	exec(`INSERT INTO dm_members (channel_id, user_id, closed_at) VALUES ($1, $2, '2021-02-01')`, ch2, ub) // B closed on ch2
	exec(`INSERT INTO dm_members (channel_id, user_id) VALUES ($1, $2)`, ch3, ud)
	exec(`INSERT INTO dm_members (channel_id, user_id) VALUES ($1, $2)`, ch3, ue)
	exec(`INSERT INTO dm_members (channel_id, user_id) VALUES ($1, $2)`, chG, ua)
	exec(`INSERT INTO dm_members (channel_id, user_id) VALUES ($1, $2)`, chG, ub)
	exec(`INSERT INTO dm_members (channel_id, user_id) VALUES ($1, $2)`, chG, uc)

	// Messages: one on each duplicate. m2 (on the loser) carries an attachment,
	// a reaction, and a pin -- all must survive the merge.
	m1, m2 := uuid.NewString(), uuid.NewString()
	exec(`INSERT INTO messages (id, channel_id, author_id, content) VALUES ($1, $2, $3, 'hi from ch1')`, m1, ch1, ua)
	exec(`INSERT INTO messages (id, channel_id, author_id, content) VALUES ($1, $2, $3, 'hi from ch2')`, m2, ch2, ub)
	exec(`INSERT INTO attachments (message_id, filename, stored_name, content_type, size, url)
	      VALUES ($1, 'a.png', 's.png', 'image/png', 1, '/f/s.png')`, m2)
	exec(`INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, '👍')`, m2, ua)
	exec(`INSERT INTO message_pins (channel_id, message_id, pinned_by) VALUES ($1, $2, $3)`, ch2, m2, ub)

	// read_states: A read both (ch2 later), B read only ch1.
	exec(`INSERT INTO read_states (user_id, channel_id, last_message_id, last_read_at) VALUES ($1, $2, $3, '2021-01-01')`, ua, ch1, m1)
	exec(`INSERT INTO read_states (user_id, channel_id, last_message_id, last_read_at) VALUES ($1, $2, $3, '2021-03-01')`, ua, ch2, m2)
	exec(`INSERT INTO read_states (user_id, channel_id, last_message_id, last_read_at) VALUES ($1, $2, $3, '2021-01-15')`, ub, ch1, m1)

	if err := m.Migrate(13); err != nil {
		t.Fatalf("migrate to v13: %v", err)
	}

	// The loser channel is gone; the winner is the older ch1.
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM channels WHERE id = $1`, ch2).Scan(&n); err != nil || n != 0 {
		t.Fatalf("loser channel ch2 must be deleted (n=%d, err=%v)", n, err)
	}
	// Both messages now live on ch1.
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM messages WHERE channel_id = $1`, ch1).Scan(&n); err != nil || n != 2 {
		t.Fatalf("winner must hold both messages, got %d (err=%v)", n, err)
	}
	// The moved message's attachment and reaction survive (they hang off message_id).
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM attachments WHERE message_id = $1`, m2).Scan(&n); err != nil || n != 1 {
		t.Fatalf("attachment on moved message lost, got %d (err=%v)", n, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM message_reactions WHERE message_id = $1`, m2).Scan(&n); err != nil || n != 1 {
		t.Fatalf("reaction on moved message lost, got %d (err=%v)", n, err)
	}
	// The pin moved to the winner.
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM message_pins WHERE channel_id = $1 AND message_id = $2`, ch1, m2).Scan(&n); err != nil || n != 1 {
		t.Fatalf("pin must move to the winner, got %d (err=%v)", n, err)
	}
	// read_states merged onto ch1: A keeps the later cursor, B keeps its own.
	var lastRead string
	if err := pool.QueryRow(ctx, `SELECT last_read_at::date::text FROM read_states WHERE user_id = $1 AND channel_id = $2`, ua, ch1).Scan(&lastRead); err != nil || lastRead != "2021-03-01" {
		t.Fatalf("A's merged read cursor must be the later date, got %q (err=%v)", lastRead, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM read_states WHERE channel_id = $1`, ch1).Scan(&n); err != nil || n != 2 {
		t.Fatalf("winner should have exactly two read_states, got %d (err=%v)", n, err)
	}
	// dm_members merged: both A and B open (any open copy wins), two rows on ch1.
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM dm_members WHERE channel_id = $1`, ch1).Scan(&n); err != nil || n != 2 {
		t.Fatalf("winner should have two members, got %d (err=%v)", n, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM dm_members WHERE channel_id = $1 AND closed_at IS NULL`, ch1).Scan(&n); err != nil || n != 2 {
		t.Fatalf("both memberships should be open after merge, got %d open (err=%v)", n, err)
	}
	// The winner is keyed with the canonical sorted pair.
	var gotLo, gotHi string
	if err := pool.QueryRow(ctx, `SELECT dm_user_lo, dm_user_hi FROM channels WHERE id = $1`, ch1).Scan(&gotLo, &gotHi); err != nil {
		t.Fatalf("read winner key: %v", err)
	}
	if gotLo != lo || gotHi != hi {
		t.Fatalf("winner key = (%s,%s), want (%s,%s)", gotLo, gotHi, lo, hi)
	}
	// The lone direct DM is keyed; the group DM stays unkeyed and intact.
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM channels WHERE id = $1 AND dm_user_lo IS NOT NULL`, ch3).Scan(&n); err != nil || n != 1 {
		t.Fatalf("lone direct DM must be keyed (n=%d, err=%v)", n, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM channels WHERE id = $1 AND dm_user_lo IS NULL`, chG).Scan(&n); err != nil || n != 1 {
		t.Fatalf("group DM must stay unkeyed (n=%d, err=%v)", n, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM dm_members WHERE channel_id = $1`, chG).Scan(&n); err != nil || n != 3 {
		t.Fatalf("group DM membership must be untouched, got %d (err=%v)", n, err)
	}
	// The unique invariant now rejects a second keyed row for the same pair.
	if _, err := pool.Exec(ctx,
		`INSERT INTO channels (name, type, dm_user_lo, dm_user_hi) VALUES ('DM', 'dm', $1, $2)`, lo, hi); err == nil {
		t.Fatal("a second channel for the same direct pair must violate the unique index")
	}

	// Down removes the invariant but does not resurrect the merged channel.
	if err := m.Migrate(12); err != nil {
		t.Fatalf("migrate down to v12: %v", err)
	}
	if columnExists(t, pool, "channels", "dm_user_lo") {
		t.Fatal("dm_user_lo should be dropped after rollback")
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM channels WHERE id = $1`, ch2).Scan(&n); err != nil || n != 0 {
		t.Fatalf("down migration must not resurrect the merged channel (n=%d, err=%v)", n, err)
	}
}
