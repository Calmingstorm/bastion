package api_test

import (
	"context"
	"crypto/sha256"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/alexedwards/argon2id"
	"github.com/google/uuid"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// botAuthMe is a trivial authenticated endpoint returning 200 for any principal,
// so its status distinguishes authenticated (200) from rejected (401/429/500)
// without needing server permissions.
const botAuthMe = "/api/v1/users/me"

// createBot creates a real bot via the API and returns its id, bot-user id, and
// one-time token. New bots carry a token_lookup digest, so they use the fast path.
func createBotFull(t *testing.T, h *testutil.Harness, owner *testutil.TestUser, serverID string) (botID, botUserID, token string) {
	t.Helper()
	var bot struct {
		ID     string `json:"id"`
		UserID string `json:"userId"`
		Token  string `json:"token"`
	}
	code := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/bots", owner.AccessToken,
		map[string]string{"username": "bot" + strings.ReplaceAll(uuid.NewString(), "-", "")[:10]}, &bot)
	if code != http.StatusCreated {
		t.Fatalf("create bot: expected 201, got %d", code)
	}
	if bot.Token == "" {
		t.Fatal("create bot must return the one-time token")
	}
	return bot.ID, bot.UserID, bot.Token
}

// makeLegacy clears a bot's token_lookup, simulating a row created before the
// hashed-lookup migration.
func makeLegacy(t *testing.T, h *testutil.Harness, botID string) {
	t.Helper()
	if _, err := h.Pool.Exec(context.Background(),
		`UPDATE bots SET token_lookup = NULL WHERE id = $1`, botID); err != nil {
		t.Fatalf("make legacy: %v", err)
	}
}

// seedLegacyBotWithToken inserts a legacy bot (token_lookup NULL) whose stored
// Argon2 hash verifies the given token and whose hint is the token's suffix. This
// gives tests control over the hint bucket that random API tokens cannot.
func seedLegacyBotWithToken(t *testing.T, h *testutil.Harness, owner *testutil.TestUser, serverID, token string) (botID, botUserID string) {
	t.Helper()
	ctx := context.Background()
	hash, err := argon2id.CreateHash(token, argon2id.DefaultParams)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	u := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	if err := h.Pool.QueryRow(ctx,
		`INSERT INTO users (username, email, password_hash, is_bot) VALUES ($1, $2, '', TRUE) RETURNING id`,
		"bu"+u, "bu"+u+"@internal").Scan(&botUserID); err != nil {
		t.Fatalf("insert bot user: %v", err)
	}
	if err := h.Pool.QueryRow(ctx,
		`INSERT INTO bots (server_id, creator_id, user_id, token_hash, token_hint, token_lookup, description)
		 VALUES ($1, $2, $3, $4, $5, NULL, '') RETURNING id`,
		serverID, owner.ID, botUserID, hash, token[len(token)-8:]).Scan(&botID); err != nil {
		t.Fatalf("insert legacy bot: %v", err)
	}
	return botID, botUserID
}

// seedHealedBots inserts n healed bots (token_lookup set) directly, cheaply, so a
// large healed population can be present without any Argon2 hashing.
func seedHealedBots(t *testing.T, h *testutil.Harness, owner *testutil.TestUser, serverID string, n int) {
	t.Helper()
	salt := strings.ReplaceAll(uuid.NewString(), "-", "")[:8]
	if _, err := h.Pool.Exec(context.Background(),
		`WITH nu AS (
			INSERT INTO users (username, email, password_hash, is_bot)
			SELECT 'hb'||g||'x'||$4, 'hb'||g||'x'||$4||'@internal', '', TRUE
			FROM generate_series(1, $1) g
			RETURNING id
		)
		INSERT INTO bots (server_id, creator_id, user_id, token_hash, token_hint, token_lookup, description)
		SELECT $2, $3, id, 'x', substr(md5(id::text), 1, 8),
		       decode(md5(id::text) || md5(id::text || 'k'), 'hex'), ''
		FROM nu`,
		n, serverID, owner.ID, salt); err != nil {
		t.Fatalf("seed healed bots: %v", err)
	}
}

// countArgon2 wraps the Argon2 comparator to count invocations for the duration
// of the test, restoring it afterward. Argon2 call count is the amplification
// signal, asserted exactly rather than via wall-clock timing.
func countArgon2(t *testing.T) *int32 {
	t.Helper()
	var n int32
	orig := auth.CompareBotToken
	auth.CompareBotToken = func(password, hash string) (bool, error) {
		atomic.AddInt32(&n, 1)
		return orig(password, hash)
	}
	t.Cleanup(func() { auth.CompareBotToken = orig })
	return &n
}

// botToken builds a shape-valid token ("bot_" + 48 hex) with the given 40-hex
// prefix and 8-hex suffix (the suffix becoming token_hint).
func mkBotToken(prefix40, suffix8 string) string { return "bot_" + prefix40 + suffix8 }

// authAsBot performs GET /users/me with a bot bearer token, returning the status.
func authAsBot(h *testutil.Harness, token string) int {
	return h.RequestAuth(http.MethodGet, botAuthMe, "bot "+token, nil, nil)
}

func lookupDigest(t *testing.T, h *testutil.Harness, botID string) []byte {
	t.Helper()
	var d []byte
	if err := h.Pool.QueryRow(context.Background(),
		`SELECT token_lookup FROM bots WHERE id = $1`, botID).Scan(&d); err != nil {
		t.Fatalf("read token_lookup: %v", err)
	}
	return d
}

// TestBotAuthNewBotUsesFastPath: a freshly created bot authenticates via the
// indexed digest with zero Argon2 work.
func TestBotAuthNewBotUsesFastPath(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	_, _, token := createBotFull(t, h, owner, serverID)

	calls := countArgon2(t)
	if code := authAsBot(h, token); code != http.StatusOK {
		t.Fatalf("fast-path auth: expected 200, got %d", code)
	}
	if got := atomic.LoadInt32(calls); got != 0 {
		t.Fatalf("fast path must perform no Argon2, got %d", got)
	}
}

// TestBotAuthLegacyHealsThenFastPath: a legacy row costs exactly one Argon2, is
// healed to its digest, and its next request costs zero.
func TestBotAuthLegacyHealsThenFastPath(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	botID, _, token := createBotFull(t, h, owner, serverID)
	makeLegacy(t, h, botID)

	calls := countArgon2(t)
	if code := authAsBot(h, token); code != http.StatusOK {
		t.Fatalf("legacy auth: expected 200, got %d", code)
	}
	if got := atomic.LoadInt32(calls); got != 1 {
		t.Fatalf("legacy auth must perform exactly one Argon2, got %d", got)
	}
	want := sha256.Sum256([]byte(token))
	if got := lookupDigest(t, h, botID); string(got) != string(want[:]) {
		t.Fatal("successful legacy auth must heal token_lookup to the digest")
	}

	atomic.StoreInt32(calls, 0)
	if code := authAsBot(h, token); code != http.StatusOK {
		t.Fatalf("post-heal auth: expected 200, got %d", code)
	}
	if got := atomic.LoadInt32(calls); got != 0 {
		t.Fatalf("post-heal auth must use the fast path, got %d Argon2", got)
	}
}

// TestBotAuthMalformedTokensCostNothing: shape-invalid tokens are rejected with
// zero Argon2, even while a real legacy bot exists.
func TestBotAuthMalformedTokensCostNothing(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	seedLegacyBotWithToken(t, h, owner, serverID,
		mkBotToken("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "deadbeef"))

	calls := countArgon2(t)
	for _, bad := range []string{
		"",
		"bot_short",
		"bot_" + strings.Repeat("A", 48),       // uppercase, not lowercase hex
		"bot_" + strings.Repeat("0", 47) + "g", // 48 chars but a non-hex digit
		"notbot_" + strings.Repeat("0", 48),    // wrong prefix
		"bot_" + strings.Repeat("0", 49),       // too long
	} {
		if code := authAsBot(h, bad); code != http.StatusUnauthorized {
			t.Fatalf("malformed %q: expected 401, got %d", bad, code)
		}
	}
	if got := atomic.LoadInt32(calls); got != 0 {
		t.Fatalf("malformed tokens must perform no Argon2, got %d", got)
	}
}

// TestBotAuthBogusTokenStaysInHintBucket: a well-formed bogus token costs zero
// Argon2 when its hint is unused and exactly one when it collides with a single
// legacy hint -- never the whole table.
func TestBotAuthBogusTokenStaysInHintBucket(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	seedLegacyBotWithToken(t, h, owner, serverID,
		mkBotToken("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "deadbeef"))

	calls := countArgon2(t)
	unused := mkBotToken("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "cafef00d")
	if code := authAsBot(h, unused); code != http.StatusUnauthorized {
		t.Fatalf("unused-hint bogus: expected 401, got %d", code)
	}
	if got := atomic.LoadInt32(calls); got != 0 {
		t.Fatalf("unused-hint bogus must perform no Argon2, got %d", got)
	}

	atomic.StoreInt32(calls, 0)
	sharing := mkBotToken("cccccccccccccccccccccccccccccccccccccccc", "deadbeef")
	if code := authAsBot(h, sharing); code != http.StatusUnauthorized {
		t.Fatalf("shared-hint bogus: expected 401, got %d", code)
	}
	if got := atomic.LoadInt32(calls); got != 1 {
		t.Fatalf("shared-hint bogus must perform exactly one Argon2, got %d", got)
	}
}

// TestBotAuthDuplicateHintSelectsCorrectBot: two legacy bots sharing a hint are a
// two-member bucket; the right one authenticates and the count never exceeds the
// bucket size.
func TestBotAuthDuplicateHintSelectsCorrectBot(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	tok1 := mkBotToken("1111111111111111111111111111111111111111", "deadbeef")
	tok2 := mkBotToken("2222222222222222222222222222222222222222", "deadbeef")
	seedLegacyBotWithToken(t, h, owner, serverID, tok1)
	bot2ID, bot2UserID := seedLegacyBotWithToken(t, h, owner, serverID, tok2)

	calls := countArgon2(t)
	var me struct {
		ID string `json:"id"`
	}
	if code := h.RequestAuth(http.MethodGet, botAuthMe, "bot "+tok2, nil, &me); code != http.StatusOK {
		t.Fatalf("dup-hint auth: expected 200, got %d", code)
	}
	if me.ID != bot2UserID {
		t.Fatalf("authenticated the wrong bot: got user %s, want %s", me.ID, bot2UserID)
	}
	if got := atomic.LoadInt32(calls); got < 1 || got > 2 {
		t.Fatalf("Argon2 count must stay within the 2-member bucket, got %d", got)
	}
	if lookupDigest(t, h, bot2ID) == nil {
		t.Fatal("the matched legacy bot must be healed")
	}
}

// TestBotAuthHealedRowsDoNotAffectUnmatchedCount: a large healed population plus
// legacy rows on other hints leave an unmatched request at zero Argon2.
func TestBotAuthHealedRowsDoNotAffectUnmatchedCount(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	seedHealedBots(t, h, owner, serverID, 100)
	seedLegacyBotWithToken(t, h, owner, serverID,
		mkBotToken("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "deadbeef"))

	calls := countArgon2(t)
	unmatched := mkBotToken("ffffffffffffffffffffffffffffffffffffffff", "0badf00d")
	if code := authAsBot(h, unmatched); code != http.StatusUnauthorized {
		t.Fatalf("unmatched auth: expected 401, got %d", code)
	}
	if got := atomic.LoadInt32(calls); got != 0 {
		t.Fatalf("unmatched request must be unaffected by healed rows, got %d Argon2", got)
	}
}

// TestBotAuthLegacySaturationThrottles is Odin's saturation regression: a legacy
// candidate exists but the Argon2 permit is unavailable, so the request is
// throttled (429 + Retry-After) with zero Argon2 and no heal.
func TestBotAuthLegacySaturationThrottles(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	tok := mkBotToken("dddddddddddddddddddddddddddddddddddddddd", "deadbeef")
	botID, _ := seedLegacyBotWithToken(t, h, owner, serverID, tok)

	auth.SetLegacyArgon2Budget(0) // permanently saturated
	t.Cleanup(func() { auth.SetLegacyArgon2Budget(auth.DefaultLegacyArgon2Budget) })

	calls := countArgon2(t)
	req, err := http.NewRequest(http.MethodGet, h.URL(botAuthMe), nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("Authorization", "bot "+tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("saturated legacy auth: expected 429, got %d", resp.StatusCode)
	}
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("throttled response must carry a Retry-After header")
	}
	if got := atomic.LoadInt32(calls); got != 0 {
		t.Fatalf("throttled request must perform no Argon2, got %d", got)
	}
	if d := lookupDigest(t, h, botID); d != nil {
		t.Fatal("throttled auth must not heal token_lookup")
	}
}

// TestBotAuthConcurrentHealingIsSafe: many simultaneous first authentications of
// a legacy bot all succeed and heal exactly once, with no unique-index failure.
func TestBotAuthConcurrentHealingIsSafe(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	botID, _, token := createBotFull(t, h, owner, serverID)
	makeLegacy(t, h, botID)

	const n = 6
	auth.SetLegacyArgon2Budget(n) // let all candidates race the heal, not the gate
	t.Cleanup(func() { auth.SetLegacyArgon2Budget(auth.DefaultLegacyArgon2Budget) })

	var wg sync.WaitGroup
	codes := make([]int, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = authAsBot(h, token)
		}(i)
	}
	wg.Wait()

	for i, c := range codes {
		if c != http.StatusOK {
			t.Fatalf("concurrent auth %d: expected 200, got %d", i, c)
		}
	}
	want := sha256.Sum256([]byte(token))
	if got := lookupDigest(t, h, botID); string(got) != string(want[:]) {
		t.Fatal("token_lookup must be healed to the digest after concurrent auth")
	}
}

// TestBotAuthDatabaseErrorReturns500: a query error must surface as 500, never be
// silently converted into an invalid-token 401.
func TestBotAuthDatabaseErrorReturns500(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	_, _, token := createBotFull(t, h, owner, serverID)

	if _, err := h.Pool.Exec(context.Background(),
		`ALTER TABLE bots DROP COLUMN token_lookup`); err != nil {
		t.Fatalf("drop column: %v", err)
	}
	if code := authAsBot(h, token); code != http.StatusInternalServerError {
		t.Fatalf("db error must surface as 500, not 401; got %d", code)
	}
}

// TestBotAuthHealFailureReturns500: a genuine lazy-heal write error must surface
// as 500, not authenticate silently past a failing write (which would also leave
// the bot permanently on the Argon2 path). A concurrent zero-row heal is a nil
// error, so this only fires on a real fault -- here a trigger forcing the
// NULL -> digest update to raise.
func TestBotAuthHealFailureReturns500(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	botID, _, token := createBotFull(t, h, owner, serverID)
	makeLegacy(t, h, botID)

	ctx := context.Background()
	if _, err := h.Pool.Exec(ctx,
		`CREATE OR REPLACE FUNCTION block_heal() RETURNS trigger AS $$
		 BEGIN RAISE EXCEPTION 'forced lazy-heal failure'; END; $$ LANGUAGE plpgsql`); err != nil {
		t.Fatalf("create fn: %v", err)
	}
	if _, err := h.Pool.Exec(ctx,
		`CREATE TRIGGER block_heal_trg BEFORE UPDATE OF token_lookup ON bots
		 FOR EACH ROW WHEN (OLD.token_lookup IS NULL AND NEW.token_lookup IS NOT NULL)
		 EXECUTE FUNCTION block_heal()`); err != nil {
		t.Fatalf("create trigger: %v", err)
	}

	if code := authAsBot(h, token); code != http.StatusInternalServerError {
		t.Fatalf("lazy-heal write failure must return 500, got %d", code)
	}
}

// TestBotAuthRegenerationRotatesLookup: regenerating a bot's token must rotate
// the lookup digest -- the old token stops authenticating and the new one uses
// the fast path. Removing token_lookup from the regeneration update fails here.
func TestBotAuthRegenerationRotatesLookup(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	botID, _, oldToken := createBotFull(t, h, owner, serverID)

	if code := authAsBot(h, oldToken); code != http.StatusOK {
		t.Fatalf("pre-rotation auth: expected 200, got %d", code)
	}

	var resp struct {
		Token string `json:"token"`
	}
	if code := h.Request(http.MethodPost,
		"/api/v1/servers/"+serverID+"/bots/"+botID+"/regenerate-token",
		owner.AccessToken, nil, &resp); code != http.StatusOK {
		t.Fatalf("regenerate: expected 200, got %d", code)
	}
	if resp.Token == "" || resp.Token == oldToken {
		t.Fatal("regeneration must return a fresh token")
	}

	// The old token no longer authenticates and costs no Argon2 (its digest is
	// gone and its row is no longer legacy).
	calls := countArgon2(t)
	if code := authAsBot(h, oldToken); code != http.StatusUnauthorized {
		t.Fatalf("old token after rotation: expected 401, got %d", code)
	}
	// The new token authenticates via the fast path.
	if code := authAsBot(h, resp.Token); code != http.StatusOK {
		t.Fatalf("new token: expected 200, got %d", code)
	}
	if got := atomic.LoadInt32(calls); got != 0 {
		t.Fatalf("rotated tokens must use the fast path, got %d Argon2", got)
	}
	// The stored lookup is the new token's 32-byte SHA-256 digest.
	want := sha256.Sum256([]byte(resp.Token))
	if got := lookupDigest(t, h, botID); string(got) != string(want[:]) {
		t.Fatal("regeneration must store the new token's SHA-256 digest")
	}
}

// TestBotAuthPausedLegacyLosesToRegeneration: if an old legacy token's Argon2
// match completes but regeneration installs a new digest before the heal runs,
// the guarded heal affects zero rows and the rotated-away token must be REJECTED
// -- not admitted on a now-stale match. A zero-row heal that authenticates
// anyway (or a heal WHERE that ignores the current digest) fails this.
func TestBotAuthPausedLegacyLosesToRegeneration(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	botID, _, oldToken := createBotFull(t, h, owner, serverID)
	makeLegacy(t, h, botID)

	// Pause the first Argon2 comparison after it computes its (matching) result
	// but before the handler heals, so regeneration can win the race in between.
	reached := make(chan struct{})
	resume := make(chan struct{})
	var once sync.Once
	orig := auth.CompareBotToken
	auth.CompareBotToken = func(password, hash string) (bool, error) {
		match, err := orig(password, hash)
		once.Do(func() { close(reached); <-resume })
		return match, err
	}
	t.Cleanup(func() { auth.CompareBotToken = orig })

	codeCh := make(chan int, 1)
	go func() { codeCh <- authAsBot(h, oldToken) }()
	<-reached // the old-token auth has matched and is paused before healing

	// Regeneration wins: it installs a different digest and returns 200.
	var resp struct {
		Token string `json:"token"`
	}
	if code := h.Request(http.MethodPost,
		"/api/v1/servers/"+serverID+"/bots/"+botID+"/regenerate-token",
		owner.AccessToken, nil, &resp); code != http.StatusOK {
		t.Fatalf("regenerate: expected 200, got %d", code)
	}

	// Resume the paused auth. Its guarded heal now affects zero rows, so the
	// rotated-away credential must be rejected.
	close(resume)
	if code := <-codeCh; code != http.StatusUnauthorized {
		t.Fatalf("token rotated away mid-auth must be rejected, got %d", code)
	}
}
