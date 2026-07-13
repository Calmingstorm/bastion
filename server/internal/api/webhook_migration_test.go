package api_test

import (
	"context"
	"crypto/sha256"
	"testing"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5/pgxpool"

	server "github.com/Calmingstorm/bastion/server"
	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

func newMigrator(t *testing.T, dsn string) *migrate.Migrate {
	t.Helper()
	src, err := iofs.New(server.MigrationsFS, "migrations")
	if err != nil {
		t.Fatalf("migration source: %v", err)
	}
	m, err := migrate.NewWithSourceInstance("iofs", src, "pgx5://"+dsn[len("postgres://"):])
	if err != nil {
		t.Fatalf("migrator: %v", err)
	}
	t.Cleanup(func() { _, _ = m.Close() })
	return m
}

// TestMigration011HashesExistingPlaintextWebhook runs the real migration: it seeds
// a plaintext webhook at schema v10, applies 011, and verifies the plaintext is
// gone and its SHA-256 backfilled — then that the down migration rotates to a
// fresh token. A broken 011 backfill would fail here (unlike a test that starts
// post-migration and repeats digest() by hand).
func TestMigration011HashesExistingPlaintextWebhook(t *testing.T) {
	dsn := testutil.NewMigrationDB(t)
	m := newMigrator(t, dsn)

	if err := m.Migrate(10); err != nil {
		t.Fatalf("migrate to v10: %v", err)
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	// Seed a plaintext webhook and its FK chain at the v10 schema.
	token := "whk_00112233445566778899aabbccddeeff"
	var ownerID, serverID, channelID, whUserID, whID string
	must := func(q string, args ...any) string {
		var id string
		if err := pool.QueryRow(ctx, q, args...).Scan(&id); err != nil {
			t.Fatalf("seed (%s): %v", q, err)
		}
		return id
	}
	ownerID = must(`INSERT INTO users (username, email, password_hash) VALUES ('owner', 'owner@x', '') RETURNING id`)
	serverID = must(`INSERT INTO servers (name, owner_id) VALUES ('S', $1) RETURNING id`, ownerID)
	channelID = must(`INSERT INTO channels (server_id, name, type) VALUES ($1, 'general', 'text') RETURNING id`, serverID)
	whUserID = must(`INSERT INTO users (username, email, password_hash, is_bot) VALUES ('wh', 'wh@x', '', TRUE) RETURNING id`)
	whID = must(`INSERT INTO webhooks (server_id, channel_id, creator_id, name, token, user_id)
	             VALUES ($1, $2, $3, 'hook', $4, $5) RETURNING id`, serverID, channelID, ownerID, token, whUserID)

	// Apply migration 011.
	if err := m.Migrate(11); err != nil {
		t.Fatalf("migrate to v11: %v", err)
	}

	// The plaintext column is gone.
	if columnExists(t, pool, "webhooks", "token") {
		t.Fatal("token column should be dropped after 011")
	}
	// The backfilled hash is SHA-256 of the original token; hint is the last 8.
	var storedHash []byte
	var hint string
	if err := pool.QueryRow(ctx, `SELECT token_hash, token_hint FROM webhooks WHERE id = $1`, whID).
		Scan(&storedHash, &hint); err != nil {
		t.Fatalf("read migrated row: %v", err)
	}
	want := sha256.Sum256([]byte(token))
	if len(storedHash) != sha256.Size || string(storedHash) != string(want[:]) {
		t.Fatal("011 backfill did not store SHA-256 of the original token")
	}
	if hint != token[len(token)-8:] {
		t.Fatalf("token_hint = %q, want last 8 of the token", hint)
	}

	// The down migration rotates to a fresh non-empty token and drops the hash.
	if err := m.Migrate(10); err != nil {
		t.Fatalf("migrate down to v10: %v", err)
	}
	var rotated string
	if err := pool.QueryRow(ctx, `SELECT token FROM webhooks WHERE id = $1`, whID).Scan(&rotated); err != nil {
		t.Fatalf("read rolled-back row: %v", err)
	}
	if rotated == "" || rotated == token {
		t.Fatalf("down migration should rotate to a fresh token, got %q", rotated)
	}
	if columnExists(t, pool, "webhooks", "token_hash") {
		t.Fatal("token_hash column should be dropped after rollback")
	}
}

func columnExists(t *testing.T, pool *pgxpool.Pool, table, column string) bool {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
		table, column).Scan(&n); err != nil {
		t.Fatalf("column check: %v", err)
	}
	return n > 0
}
