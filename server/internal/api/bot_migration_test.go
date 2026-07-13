package api_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// TestMigration012AddsBotTokenLookup runs the real migration against a legacy bot
// row: it seeds a bot at schema v11 (token_hash only), applies 012, and verifies
// the additive column, its length CHECK, the two partial indexes, and that the
// pre-existing row is left un-healed (NULL) rather than fabricated. The down
// migration must remove the column and indexes.
func TestMigration012AddsBotTokenLookup(t *testing.T) {
	dsn := testutil.NewMigrationDB(t)
	m := newMigrator(t, dsn)

	if err := m.Migrate(11); err != nil {
		t.Fatalf("migrate to v11: %v", err)
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	must := func(q string, args ...any) string {
		var id string
		if err := pool.QueryRow(ctx, q, args...).Scan(&id); err != nil {
			t.Fatalf("seed (%s): %v", q, err)
		}
		return id
	}
	ownerID := must(`INSERT INTO users (username, email, password_hash) VALUES ('owner', 'owner@x', '') RETURNING id`)
	serverID := must(`INSERT INTO servers (name, owner_id) VALUES ('S', $1) RETURNING id`, ownerID)
	botUserID := must(`INSERT INTO users (username, email, password_hash, is_bot) VALUES ('b', 'b@x', '', TRUE) RETURNING id`)
	botID := must(`INSERT INTO bots (server_id, creator_id, user_id, token_hash, token_hint)
	               VALUES ($1, $2, $3, 'argon2hash', 'deadbeef') RETURNING id`, serverID, ownerID, botUserID)

	// Apply migration 012.
	if err := m.Migrate(12); err != nil {
		t.Fatalf("migrate to v12: %v", err)
	}

	// The column exists and the pre-existing row is left NULL -- the migration
	// must not fabricate a digest it cannot compute from a lost plaintext token.
	if !columnExists(t, pool, "bots", "token_lookup") {
		t.Fatal("token_lookup column should exist after 012")
	}
	var isNull bool
	if err := pool.QueryRow(ctx, `SELECT token_lookup IS NULL FROM bots WHERE id = $1`, botID).Scan(&isNull); err != nil {
		t.Fatalf("read migrated row: %v", err)
	}
	if !isNull {
		t.Fatal("legacy bot row must be NULL after the additive migration")
	}

	for _, idx := range []string{"idx_bots_token_lookup", "idx_bots_legacy_hint"} {
		if !indexExists(t, pool, idx) {
			t.Fatalf("index %s should exist after 012", idx)
		}
	}

	// The length CHECK rejects a non-32-byte digest and accepts a 32-byte one.
	if _, err := pool.Exec(ctx, `UPDATE bots SET token_lookup = decode('0102', 'hex') WHERE id = $1`, botID); err == nil {
		t.Fatal("CHECK must reject a non-32-byte token_lookup")
	}
	if _, err := pool.Exec(ctx, `UPDATE bots SET token_lookup = decode(repeat('ab', 32), 'hex') WHERE id = $1`, botID); err != nil {
		t.Fatalf("a 32-byte token_lookup should be accepted: %v", err)
	}

	// The down migration removes the column and its partial indexes.
	if err := m.Migrate(11); err != nil {
		t.Fatalf("migrate down to v11: %v", err)
	}
	if columnExists(t, pool, "bots", "token_lookup") {
		t.Fatal("token_lookup column should be dropped after rollback")
	}
	if indexExists(t, pool, "idx_bots_token_lookup") || indexExists(t, pool, "idx_bots_legacy_hint") {
		t.Fatal("partial indexes should be dropped after rollback")
	}
}

func indexExists(t *testing.T, pool *pgxpool.Pool, name string) bool {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM pg_indexes WHERE indexname = $1`, name).Scan(&n); err != nil {
		t.Fatalf("index check: %v", err)
	}
	return n > 0
}
