package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/textproto"
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

// TestListRejectsCursorFromAnotherChannel: a before cursor belongs to one
// channel's keyset. Accepting an id from another channel can silently skip or
// fabricate a page boundary for the requested channel.
func TestListRejectsCursorFromAnotherChannel(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelA := h.CreateChannel(owner, serverID, "a")
	channelB := h.CreateChannel(owner, serverID, "b")

	foreignCursor := sendMessage(h, owner, channelA, "foreign cursor")
	sendMessage(h, owner, channelB, "message in requested channel")

	var out any
	if code := h.Request(http.MethodGet,
		"/api/v1/channels/"+channelB+"/messages?before="+foreignCursor,
		owner.AccessToken, nil, &out); code != http.StatusBadRequest {
		t.Fatalf("foreign-channel cursor: expected 400, got %d", code)
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
	for position, f := range []struct{ name, stored string }{
		{"a.png", "stored-a.png"},
		{"b.pdf", "stored-b.pdf"},
	} {
		if _, err := h.Pool.Exec(context.Background(),
			`INSERT INTO attachments (message_id, filename, stored_name, content_type, size, url, position)
			 VALUES ($1, $2, $3, 'application/octet-stream', 3, '/uploads/'||$3, $4)`,
			withAtt, f.name, f.stored, position,
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

// TestListAttachmentQueryFailureReturns500: attachment hydration is part of a
// successful history response. If its query fails, returning attachment-free
// messages with 200 would recreate the corruption this endpoint is fixing.
func TestListAttachmentQueryFailureReturns500(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	sendMessage(h, owner, channelID, "attachment query must run")

	if _, err := h.Pool.Exec(context.Background(), `ALTER TABLE attachments RENAME TO attachments_unavailable`); err != nil {
		t.Fatalf("hide attachments table: %v", err)
	}
	t.Cleanup(func() {
		if _, err := h.Pool.Exec(context.Background(), `ALTER TABLE attachments_unavailable RENAME TO attachments`); err != nil {
			t.Errorf("restore attachments table: %v", err)
		}
	})

	var out any
	if code := h.Request(http.MethodGet,
		"/api/v1/channels/"+channelID+"/messages", owner.AccessToken, nil, &out); code != http.StatusInternalServerError {
		t.Fatalf("failed attachment query: expected 500, got %d", code)
	}
}

// TestUploadedAttachmentOrderSurvivesHistoryReload exercises the production
// multi-file upload transaction. Both rows receive the same transaction
// timestamp, so only the persisted position can make the List response match
// the realtime/upload response order.
func TestUploadedAttachmentOrderSurvivesHistoryReload(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if err := mw.WriteField("content", "ordered files"); err != nil {
		t.Fatalf("write content field: %v", err)
	}
	for _, filename := range []string{"first.png", "second.png"} {
		header := make(textproto.MIMEHeader)
		header.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, "files", filename))
		header.Set("Content-Type", "image/png")
		part, err := mw.CreatePart(header)
		if err != nil {
			t.Fatalf("create %s part: %v", filename, err)
		}
		if _, err := part.Write(pngPixel); err != nil {
			t.Fatalf("write %s: %v", filename, err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart body: %v", err)
	}

	req, err := http.NewRequest(http.MethodPost,
		h.URL("/api/v1/channels/"+channelID+"/messages/upload"), &body)
	if err != nil {
		t.Fatalf("build upload request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+owner.AccessToken)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("upload files: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("upload files: expected 201, got %d", resp.StatusCode)
	}

	type attachment struct {
		ID       string `json:"id"`
		Filename string `json:"filename"`
	}
	var uploaded struct {
		ID          string       `json:"id"`
		Attachments []attachment `json:"attachments"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&uploaded); err != nil {
		t.Fatalf("decode upload response: %v", err)
	}
	if len(uploaded.Attachments) != 2 ||
		uploaded.Attachments[0].Filename != "first.png" || uploaded.Attachments[1].Filename != "second.png" {
		t.Fatalf("unexpected upload order: %+v", uploaded.Attachments)
	}

	var distinctTimes, minPosition, maxPosition int
	if err := h.Pool.QueryRow(context.Background(),
		`SELECT COUNT(DISTINCT created_at), MIN(position), MAX(position)
		   FROM attachments WHERE message_id = $1`, uploaded.ID,
	).Scan(&distinctTimes, &minPosition, &maxPosition); err != nil {
		t.Fatalf("inspect attachment transaction: %v", err)
	}
	if distinctTimes != 1 {
		t.Fatalf("expected same-transaction timestamp tie, got %d distinct timestamps", distinctTimes)
	}
	if minPosition != 0 || maxPosition != 1 {
		t.Fatalf("persisted positions = %d..%d, want 0..1", minPosition, maxPosition)
	}

	var list []struct {
		ID          string       `json:"id"`
		Attachments []attachment `json:"attachments"`
	}
	if code := h.Request(http.MethodGet,
		"/api/v1/channels/"+channelID+"/messages", owner.AccessToken, nil, &list); code != http.StatusOK {
		t.Fatalf("list: expected 200, got %d", code)
	}
	if len(list) != 1 || list[0].ID != uploaded.ID {
		t.Fatalf("unexpected message list: %+v", list)
	}
	if len(list[0].Attachments) != 2 ||
		list[0].Attachments[0].ID != uploaded.Attachments[0].ID ||
		list[0].Attachments[1].ID != uploaded.Attachments[1].ID {
		t.Fatalf("reload order does not match upload order: upload=%+v reload=%+v",
			uploaded.Attachments, list[0].Attachments)
	}
}
