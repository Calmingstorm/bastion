package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

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

// rawCreateDM posts a 1:1 DM over a bare HTTP client, safe to call from a
// goroutine (no t.Fatalf). Returns the status and channel id.
func rawCreateDM(h *testutil.Harness, u *testutil.TestUser, recipientID string) (int, string) {
	payload, _ := json.Marshal(map[string]any{"recipientIds": []string{recipientID}})
	req, err := http.NewRequest(http.MethodPost, h.URL("/api/v1/dm"), bytes.NewReader(payload))
	if err != nil {
		return -1, ""
	}
	req.Header.Set("Authorization", "Bearer "+u.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return -1, ""
	}
	defer func() { _ = resp.Body.Close() }()
	var ch struct {
		ID string `json:"id"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&ch)
	return resp.StatusCode, ch.ID
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
			code, id := rawCreateDM(h, u, rid)
			results[i] = result{code, id}
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

// TestDMDirectNeverAdoptsLegacyUnknown: a pre-migration legacy_unknown channel
// (which could be a shrunk group) must never be returned as a direct DM. A
// direct request creates a fresh keyed channel instead.
func TestDMDirectNeverAdoptsLegacyUnknown(t *testing.T) {
	h := testutil.New(t)
	a := h.Register("alice")
	b := h.Register("bob")

	ctx := context.Background()
	var legacyID string
	if err := h.Pool.QueryRow(ctx,
		`INSERT INTO channels (name, type, dm_kind) VALUES ('DM','dm','legacy_unknown') RETURNING id`).Scan(&legacyID); err != nil {
		t.Fatalf("seed legacy channel: %v", err)
	}
	if _, err := h.Pool.Exec(ctx,
		`INSERT INTO dm_members (channel_id, user_id) VALUES ($1,$2),($1,$3)`, legacyID, a.ID, b.ID); err != nil {
		t.Fatalf("seed members: %v", err)
	}

	code, direct := createDM(t, h, a, b.ID)
	if code != http.StatusCreated {
		t.Fatalf("expected a fresh direct 201, got %d", code)
	}
	if direct == legacyID {
		t.Fatal("must not adopt a legacy_unknown channel as a direct DM")
	}
	var kind string
	if err := h.Pool.QueryRow(ctx, `SELECT dm_kind FROM channels WHERE id = $1`, direct).Scan(&kind); err != nil || kind != "direct" {
		t.Fatalf("new channel should be dm_kind=direct, got %q (err=%v)", kind, err)
	}
}

// TestDMDirectFansOutExactlyOnce: reverse-direction concurrent creates emit
// exactly one DM_CREATE total (to whichever recipient the winner had); later
// existing-channel requests in both directions emit none.
func TestDMDirectFansOutExactlyOnce(t *testing.T) {
	h := testutil.New(t)
	a := h.Register("alice")
	b := h.Register("bob")

	aWS := h.DialWS(a)
	bWS := h.DialWS(b)

	const n = 6
	codes := make([]int, n)
	ids := make([]string, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			u, rid := a, b.ID
			if i%2 == 1 {
				u, rid = b, a.ID
			}
			codes[i], ids[i] = rawCreateDM(h, u, rid)
		}(i)
	}
	wg.Wait()

	created, chID := 0, ""
	for i := range codes {
		if codes[i] == http.StatusCreated {
			created++
			chID = ids[i]
		}
	}
	if created != 1 {
		t.Fatalf("expected exactly one creating request, got %d", created)
	}

	// Exactly one DM_CREATE lands across both sockets, for the winning channel.
	total := aWS.CountEvents("DM_CREATE", 800*time.Millisecond) + bWS.CountEvents("DM_CREATE", 800*time.Millisecond)
	if total != 1 {
		t.Fatalf("expected exactly one DM_CREATE across both sockets, got %d (channel %s)", total, chID)
	}

	// Later existing-channel requests (both directions) fan out nothing.
	if code, _ := createDM(t, h, a, b.ID); code != http.StatusOK {
		t.Fatalf("existing create A->B: expected 200, got %d", code)
	}
	if code, _ := createDM(t, h, b, a.ID); code != http.StatusOK {
		t.Fatalf("existing create B->A: expected 200, got %d", code)
	}
	if extra := aWS.CountEvents("DM_CREATE", 400*time.Millisecond) + bWS.CountEvents("DM_CREATE", 400*time.Millisecond); extra != 0 {
		t.Fatalf("existing-channel requests must not fan out DM_CREATE, got %d", extra)
	}
}
