package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"

	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// createDM posts a 1:1 DM request and returns the status and the channel id.
func createDM(t *testing.T, h *testutil.Harness, u *testutil.TestUser, recipientID string) (int, string) {
	t.Helper()
	var ch struct {
		ID string `json:"id"`
	}
	code := h.Request(http.MethodPost, "/api/v1/dm", u.AccessToken,
		map[string]any{"recipientIds": []string{recipientID}}, &ch)
	return code, ch.ID
}

func countDirectChannels(t *testing.T, h *testutil.Harness) int {
	t.Helper()
	var n int
	if err := h.Pool.QueryRow(context.Background(),
		`SELECT count(*) FROM channels WHERE dm_user_lo IS NOT NULL`).Scan(&n); err != nil {
		t.Fatalf("count direct channels: %v", err)
	}
	return n
}

// TestDMDirectCreateIsIdempotent: the first request creates (201); repeat and
// reverse-direction requests return the same channel (200). Exactly one channel
// with two members exists.
func TestDMDirectCreateIsIdempotent(t *testing.T) {
	h := testutil.New(t)
	a := h.Register("alice")
	b := h.Register("bob")

	code1, ch1 := createDM(t, h, a, b.ID)
	if code1 != http.StatusCreated || ch1 == "" {
		t.Fatalf("first create: expected 201 + id, got %d %q", code1, ch1)
	}
	code2, ch2 := createDM(t, h, a, b.ID)
	if code2 != http.StatusOK || ch2 != ch1 {
		t.Fatalf("repeat create: expected 200 + same id, got %d %q", code2, ch2)
	}
	code3, ch3 := createDM(t, h, b, a.ID)
	if code3 != http.StatusOK || ch3 != ch1 {
		t.Fatalf("reverse create: expected 200 + same id, got %d %q", code3, ch3)
	}

	if n := countDirectChannels(t, h); n != 1 {
		t.Fatalf("expected exactly one direct channel, got %d", n)
	}
	var members int
	if err := h.Pool.QueryRow(context.Background(),
		`SELECT count(*) FROM dm_members WHERE channel_id = $1`, ch1).Scan(&members); err != nil || members != 2 {
		t.Fatalf("expected two members, got %d (err=%v)", members, err)
	}
}

// TestDMDirectConcurrentCreatesConverge: many simultaneous A->B and B->A requests
// converge on one channel -- exactly one 201, the rest 200, all the same id.
func TestDMDirectConcurrentCreatesConverge(t *testing.T) {
	h := testutil.New(t)
	a := h.Register("alice")
	b := h.Register("bob")

	const n = 8
	type result struct {
		code int
		id   string
	}
	results := make([]result, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			u, rid := a, b.ID
			if i%2 == 1 {
				u, rid = b, a.ID
			}
			payload, _ := json.Marshal(map[string]any{"recipientIds": []string{rid}})
			req, err := http.NewRequest(http.MethodPost, h.URL("/api/v1/dm"), bytes.NewReader(payload))
			if err != nil {
				results[i] = result{-1, ""}
				return
			}
			req.Header.Set("Authorization", "Bearer "+u.AccessToken)
			req.Header.Set("Content-Type", "application/json")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				results[i] = result{-1, ""}
				return
			}
			defer func() { _ = resp.Body.Close() }()
			var ch struct {
				ID string `json:"id"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&ch)
			results[i] = result{resp.StatusCode, ch.ID}
		}(i)
	}
	wg.Wait()

	created, chID := 0, ""
	for i, res := range results {
		if res.code != http.StatusOK && res.code != http.StatusCreated {
			t.Fatalf("request %d: unexpected status %d", i, res.code)
		}
		if res.code == http.StatusCreated {
			created++
		}
		if chID == "" {
			chID = res.id
		} else if res.id != chID {
			t.Fatalf("requests diverged: %q vs %q", res.id, chID)
		}
	}
	if created != 1 {
		t.Fatalf("expected exactly one 201 creator, got %d", created)
	}
	if n := countDirectChannels(t, h); n != 1 {
		t.Fatalf("concurrency created %d direct channels, want 1", n)
	}
	var members int
	if err := h.Pool.QueryRow(context.Background(),
		`SELECT count(*) FROM dm_members WHERE channel_id = $1`, chID).Scan(&members); err != nil || members != 2 {
		t.Fatalf("expected two members, got %d (err=%v)", members, err)
	}
}

// TestDMDirectDoesNotMatchGroupDM: a group DM containing A and B must not satisfy
// a 1:1 A-B request (the old pair-join could false-match it).
func TestDMDirectDoesNotMatchGroupDM(t *testing.T) {
	h := testutil.New(t)
	a := h.Register("alice")
	b := h.Register("bob")
	c := h.Register("carol")

	var group struct {
		ID string `json:"id"`
	}
	if code := h.Request(http.MethodPost, "/api/v1/dm", a.AccessToken,
		map[string]any{"recipientIds": []string{b.ID, c.ID}}, &group); code != http.StatusCreated {
		t.Fatalf("group create: expected 201, got %d", code)
	}

	code, direct := createDM(t, h, a, b.ID)
	if code != http.StatusCreated {
		t.Fatalf("1:1 after group: expected a fresh 201, got %d", code)
	}
	if direct == group.ID {
		t.Fatal("a 1:1 DM must not reuse a group DM channel")
	}
}

// TestDMSelfRejected: a DM to yourself is rejected rather than 500-ing on the key
// constraint.
func TestDMSelfRejected(t *testing.T) {
	h := testutil.New(t)
	a := h.Register("alice")
	if code, _ := createDM(t, h, a, a.ID); code != http.StatusBadRequest {
		t.Fatalf("self-DM should be 400, got %d", code)
	}
}

// TestDMDirectForcedFailureLeavesNoOrphan: if the member insert fails, the whole
// create transaction rolls back -- no orphan channel, no partial membership.
func TestDMDirectForcedFailureLeavesNoOrphan(t *testing.T) {
	h := testutil.New(t)
	a := h.Register("alice")
	b := h.Register("bob")

	ctx := context.Background()
	if _, err := h.Pool.Exec(ctx,
		`CREATE OR REPLACE FUNCTION block_dm_member() RETURNS trigger AS $$
		 BEGIN RAISE EXCEPTION 'forced member insert failure'; END; $$ LANGUAGE plpgsql`); err != nil {
		t.Fatalf("create fn: %v", err)
	}
	if _, err := h.Pool.Exec(ctx,
		`CREATE TRIGGER block_dm_member_trg BEFORE INSERT ON dm_members
		 FOR EACH ROW EXECUTE FUNCTION block_dm_member()`); err != nil {
		t.Fatalf("create trigger: %v", err)
	}

	if code, _ := createDM(t, h, a, b.ID); code != http.StatusInternalServerError {
		t.Fatalf("forced failure should be 500, got %d", code)
	}
	if n := countDirectChannels(t, h); n != 0 {
		t.Fatalf("rolled-back create must leave no orphan channel, got %d", n)
	}
}
