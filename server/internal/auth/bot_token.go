package auth

import (
	"context"
	"crypto/sha256"
	"regexp"

	"github.com/alexedwards/argon2id"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// botTokenPattern matches a well-formed bot token: the "bot_" namespace prefix
// followed by exactly 48 lowercase hex characters (24 bytes = 192 bits of
// CSPRNG entropy, as produced by generateBotToken).
var botTokenPattern = regexp.MustCompile(`^bot_[0-9a-f]{48}$`)

// ValidBotTokenShape reports whether s is syntactically a bot token. Rejecting
// malformed input before any database or Argon2 work bounds the legacy auth
// path: an input that cannot be a real credential performs zero Argon2 work and
// touches no rows.
func ValidBotTokenShape(s string) bool {
	return botTokenPattern.MatchString(s)
}

// BotTokenDigest returns the SHA-256 digest of a bot token. It is the indexed
// fast-path lookup key stored in bots.token_lookup. A deterministic digest is
// safe here (unlike a human password) because the token is a 192-bit random
// bearer secret a database-read attacker cannot feasibly invert.
func BotTokenDigest(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// CompareBotToken verifies a presented token against a stored Argon2 hash on the
// transitional legacy path. It is a package variable so tests can wrap it to
// assert the exact number of Argon2 comparisons performed (the real amplification
// signal, independent of wall-clock timing).
var CompareBotToken = argon2id.ComparePasswordAndHash

// AfterFastPathMissForTest, when non-nil, is invoked between the fast-path miss
// and the legacy candidate query in handleBotAuth. Tests use it to
// deterministically interleave a concurrent heal (which would otherwise be a
// rare race); it is nil in production.
var AfterFastPathMissForTest func()

// DefaultLegacyArgon2Budget bounds concurrent 64 MB Argon2 verifications on the
// legacy path so a flood of hint-matching tokens cannot exhaust memory. Kept
// small on purpose: saturation fails fast rather than queueing allocations.
const DefaultLegacyArgon2Budget = 4

// argon2Gate is a non-blocking counting semaphore. A full gate reports failure
// immediately (the caller returns 429) instead of queueing unbounded 64 MB
// allocations behind it.
type argon2Gate struct{ ch chan struct{} }

func newArgon2Gate(n int) *argon2Gate { return &argon2Gate{ch: make(chan struct{}, n)} }

// tryAcquire takes one permit without blocking, reporting whether it succeeded.
func (g *argon2Gate) tryAcquire() bool {
	select {
	case g.ch <- struct{}{}:
		return true
	default:
		return false
	}
}

func (g *argon2Gate) release() { <-g.ch }

var legacyArgon2Gate = newArgon2Gate(DefaultLegacyArgon2Budget)

// SetLegacyArgon2Budget resizes the legacy Argon2 concurrency gate. It exists
// for tests (e.g. budget 0 to force deterministic saturation) and is not called
// in production; callers must not resize it while requests are in flight.
func SetLegacyArgon2Budget(n int) { legacyArgon2Gate = newArgon2Gate(n) }

// WarnLegacyBotTokens logs, at startup, how many bot rows still lack a
// token_lookup digest and therefore still use the transitional Argon2 path. It
// is silent once every bot has been healed, and never fatal.
func WarnLegacyBotTokens(ctx context.Context, db *pgxpool.Pool) {
	var n int
	if err := db.QueryRow(ctx,
		`SELECT COUNT(*) FROM bots WHERE token_lookup IS NULL`).Scan(&n); err != nil {
		log.Warn().Err(err).Msg("failed to count legacy bot tokens")
		return
	}
	if n > 0 {
		log.Warn().Int("count", n).
			Msg("bot tokens still use the legacy Argon2 auth path; each heals on its next authentication")
	}
}
