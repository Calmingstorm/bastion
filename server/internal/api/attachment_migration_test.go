package api_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// TestMigration018BackfillsAttachmentPositions verifies that upgrading a live
// schema with existing multi-attachment messages succeeds, assigns every row a
// unique zero-based ordinal, and that the down migration removes the column.
func TestMigration018BackfillsAttachmentPositions(t *testing.T) {
	dsn := testutil.NewMigrationDB(t)
	m := newMigrator(t, dsn)
	if err := m.Migrate(17); err != nil {
		t.Fatalf("migrate to v17: %v", err)
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	mustID := func(query string, args ...any) string {
		t.Helper()
		var id string
		if err := pool.QueryRow(ctx, query, args...).Scan(&id); err != nil {
			t.Fatalf("seed migration fixture: %v", err)
		}
		return id
	}
	ownerID := mustID(`INSERT INTO users (username, email, password_hash)
		VALUES ('owner', 'owner@migration.test', '') RETURNING id`)
	serverID := mustID(`INSERT INTO servers (name, owner_id) VALUES ('S', $1) RETURNING id`, ownerID)
	channelID := mustID(`INSERT INTO channels (server_id, name, type)
		VALUES ($1, 'general', 'text') RETURNING id`, serverID)
	messageID := mustID(`INSERT INTO messages (channel_id, author_id, content)
		VALUES ($1, $2, 'attachments') RETURNING id`, channelID, ownerID)

	if _, err := pool.Exec(ctx,
		`INSERT INTO attachments (message_id, filename, stored_name, content_type, size, url, created_at)
		 VALUES ($1, 'a.png', 'a', 'image/png', 1, '/a', '2026-01-01T00:00:00Z'),
		        ($1, 'b.png', 'b', 'image/png', 1, '/b', '2026-01-01T00:00:00Z')`,
		messageID,
	); err != nil {
		t.Fatalf("seed legacy attachments: %v", err)
	}

	if err := m.Migrate(18); err != nil {
		t.Fatalf("migrate to v18: %v", err)
	}

	var count, distinct, minPosition, maxPosition int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*), COUNT(DISTINCT position), MIN(position), MAX(position)
		   FROM attachments WHERE message_id = $1`, messageID,
	).Scan(&count, &distinct, &minPosition, &maxPosition); err != nil {
		t.Fatalf("read backfilled positions: %v", err)
	}
	if count != 2 || distinct != 2 || minPosition != 0 || maxPosition != 1 {
		t.Fatalf("backfilled positions: count=%d distinct=%d range=%d..%d, want 2/2/0..1",
			count, distinct, minPosition, maxPosition)
	}

	if err := m.Migrate(17); err != nil {
		t.Fatalf("migrate down to v17: %v", err)
	}
	if columnExists(t, pool, "attachments", "position") {
		t.Fatal("position column should be dropped after rollback")
	}
}
