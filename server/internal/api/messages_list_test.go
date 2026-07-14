package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// TestListKeysetPaginationBoundaryTies: pagination must not lose messages that
// share the cursor's exact created_at. The old cursor compared created_at alone
// (strictly older), so rows tied with the cursor's timestamp -- cut from the
// prior page only by LIMIT -- were skipped forever. The keyset comparison on
// (created_at, id) pages through ties exactly once, in a stable order.
//
// Construction: 55 messages all forced to the SAME created_at. Page 1 returns 50;
// under the old cursor page 2 returned zero (nothing strictly older), silently
// losing 5 messages. Under the keyset cursor page 2 returns exactly the 5
// remaining, with no duplicates.
func TestListKeysetPaginationBoundaryTies(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	// Insert directly (the send route is user-rate-limited; the LIST path is what
	// is under test), with every message on the SAME timestamp: the worst-case tie.
	const total = 55 // one page (50) + 5 that must survive the boundary
	sent := make(map[string]bool, total)
	rows, err := h.Pool.Query(context.Background(),
		`INSERT INTO messages (channel_id, author_id, content, created_at)
		 SELECT $1, $2, 'm', '2026-01-01T00:00:00Z' FROM generate_series(1, $3)
		 RETURNING id`,
		channelID, owner.ID, total,
	)
	if err != nil {
		t.Fatalf("insert tied messages: %v", err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan inserted id: %v", err)
		}
		sent[id] = true
	}
	rows.Close()
	if len(sent) != total {
		t.Fatalf("expected %d inserted messages, got %d", total, len(sent))
	}

	type msg struct {
		ID string `json:"id"`
	}

	var page1 []msg
	if code := h.Request(http.MethodGet,
		"/api/v1/channels/"+channelID+"/messages", owner.AccessToken, nil, &page1); code != http.StatusOK {
		t.Fatalf("page 1: expected 200, got %d", code)
	}
	if len(page1) != 50 {
		t.Fatalf("page 1: expected 50 messages, got %d", len(page1))
	}

	cursor := page1[len(page1)-1].ID
	var page2 []msg
	if code := h.Request(http.MethodGet,
		"/api/v1/channels/"+channelID+"/messages?before="+cursor, owner.AccessToken, nil, &page2); code != http.StatusOK {
		t.Fatalf("page 2: expected 200, got %d", code)
	}
	if len(page2) != total-50 {
		t.Fatalf("page 2: expected %d messages (the boundary ties), got %d", total-50, len(page2))
	}

	// Every sent message appears exactly once across the two pages.
	seen := make(map[string]bool, total)
	for _, m := range append(page1, page2...) {
		if seen[m.ID] {
			t.Fatalf("message %s returned on both pages (duplicate)", m.ID)
		}
		seen[m.ID] = true
		if !sent[m.ID] {
			t.Fatalf("message %s returned but never sent", m.ID)
		}
	}
	if len(seen) != total {
		t.Fatalf("expected all %d messages across both pages, got %d (messages lost at the tie boundary)", total, len(seen))
	}
}

// TestListIncludesAttachments: List must bulk-fetch attachments like it does
// reactions. They were previously absent from every List response (only the
// realtime MESSAGE_CREATE carried them), so reloads and history pagination showed
// attachment messages without their attachments.
func TestListIncludesAttachments(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	withAtt := sendMessage(h, owner, channelID, "has attachments")
	plain := sendMessage(h, owner, channelID, "no attachments")

	// Insert attachments directly (the upload route's storage plumbing is not
	// under test here; the List fetch path is).
	for _, f := range []struct{ name, stored string }{
		{"a.png", "stored-a.png"},
		{"b.pdf", "stored-b.pdf"},
	} {
		if _, err := h.Pool.Exec(context.Background(),
			`INSERT INTO attachments (message_id, filename, stored_name, content_type, size, url)
			 VALUES ($1, $2, $3, 'application/octet-stream', 3, '/uploads/'||$3)`,
			withAtt, f.name, f.stored,
		); err != nil {
			t.Fatalf("insert attachment %s: %v", f.name, err)
		}
	}

	type attachment struct {
		Filename string `json:"filename"`
		URL      string `json:"url"`
	}
	type msg struct {
		ID          string       `json:"id"`
		Attachments []attachment `json:"attachments"`
	}

	var list []msg
	if code := h.Request(http.MethodGet,
		"/api/v1/channels/"+channelID+"/messages", owner.AccessToken, nil, &list); code != http.StatusOK {
		t.Fatalf("list: expected 200, got %d", code)
	}

	byID := make(map[string]msg, len(list))
	for _, m := range list {
		byID[m.ID] = m
	}

	got := byID[withAtt]
	if len(got.Attachments) != 2 {
		t.Fatalf("expected 2 attachments on %s, got %d", withAtt, len(got.Attachments))
	}
	// Ordered by created_at ASC (insertion order here).
	if got.Attachments[0].Filename != "a.png" || got.Attachments[1].Filename != "b.pdf" {
		t.Fatalf("unexpected attachment order/content: %+v", got.Attachments)
	}
	if got.Attachments[0].URL == "" {
		t.Fatalf("attachment URL missing: %+v", got.Attachments[0])
	}
	if len(byID[plain].Attachments) != 0 {
		t.Fatalf("plain message unexpectedly has attachments: %+v", byID[plain].Attachments)
	}
}
