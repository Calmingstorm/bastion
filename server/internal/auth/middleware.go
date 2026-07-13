package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

type contextKey string

const userIDKey contextKey = "userID"
const isBotKey contextKey = "isBot"

// Middleware validates JWT Bearer tokens (existing behavior).
func Middleware(jwtSecret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var tokenStr string

			// Check Authorization header first
			authHeader := r.Header.Get("Authorization")
			if authHeader != "" {
				parts := strings.SplitN(authHeader, " ", 2)
				if len(parts) == 2 && strings.EqualFold(parts[0], "bearer") {
					tokenStr = parts[1]
				}
			}

			// Fall back to query param (used by WebSocket connections)
			if tokenStr == "" {
				tokenStr = r.URL.Query().Get("token")
			}

			if tokenStr == "" {
				http.Error(w, `{"error":"missing authorization"}`, http.StatusUnauthorized)
				return
			}

			claims, err := ValidateToken(tokenStr, jwtSecret)
			if err != nil {
				log.Debug().Err(err).Msg("token validation failed")
				http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
				return
			}

			if claims.TokenType != "access" {
				http.Error(w, `{"error":"invalid token type"}`, http.StatusUnauthorized)
				return
			}

			userID, err := uuid.Parse(claims.Subject)
			if err != nil {
				http.Error(w, `{"error":"invalid token subject"}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), userIDKey, userID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// CombinedAuthMiddleware handles both JWT Bearer tokens and Bot tokens.
// Bot tokens use the "Bot" scheme: Authorization: Bot <token>
// Bot tokens can also be passed as query param for WebSocket: ?token=bot_...
func CombinedAuthMiddleware(jwtSecret string, db *pgxpool.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			queryToken := r.URL.Query().Get("token")

			// Check for Bot token scheme
			if authHeader != "" {
				parts := strings.SplitN(authHeader, " ", 2)
				if len(parts) == 2 && strings.EqualFold(parts[0], "bot") {
					handleBotAuth(w, r, next, parts[1], db)
					return
				}
			}

			// Check query param for bot_ prefixed tokens (WebSocket)
			if queryToken != "" && strings.HasPrefix(queryToken, "bot_") {
				handleBotAuth(w, r, next, queryToken, db)
				return
			}

			// Otherwise fall through to JWT handling
			var tokenStr string
			if authHeader != "" {
				parts := strings.SplitN(authHeader, " ", 2)
				if len(parts) == 2 && strings.EqualFold(parts[0], "bearer") {
					tokenStr = parts[1]
				}
			}
			if tokenStr == "" {
				tokenStr = queryToken
			}

			if tokenStr == "" {
				http.Error(w, `{"error":"missing authorization"}`, http.StatusUnauthorized)
				return
			}

			claims, err := ValidateToken(tokenStr, jwtSecret)
			if err != nil {
				log.Debug().Err(err).Msg("token validation failed")
				http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
				return
			}

			if claims.TokenType != "access" {
				http.Error(w, `{"error":"invalid token type"}`, http.StatusUnauthorized)
				return
			}

			userID, err := uuid.Parse(claims.Subject)
			if err != nil {
				http.Error(w, `{"error":"invalid token subject"}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), userIDKey, userID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// authenticateBot attaches the resolved bot identity to the request and
// continues the chain. Used by both the fast and legacy authentication paths.
func authenticateBot(w http.ResponseWriter, r *http.Request, next http.Handler, botUserID uuid.UUID) {
	ctx := context.WithValue(r.Context(), userIDKey, botUserID)
	ctx = context.WithValue(ctx, isBotKey, true)
	next.ServeHTTP(w, r.WithContext(ctx))
}

// handleBotAuth authenticates a bot bearer token. The normal path is a single
// indexed lookup on the token's SHA-256 digest (no Argon2). Only tokens that
// miss the fast path fall to a transitional Argon2 check, and even then only
// against un-healed legacy rows sharing the presented token's hint -- never the
// whole table. This closes the O(number-of-bots) Argon2 amplification the old
// full-table scan exposed to unauthenticated callers.
func handleBotAuth(w http.ResponseWriter, r *http.Request, next http.Handler, token string, db *pgxpool.Pool) {
	// Reject malformed tokens before any database or Argon2 work, so a bogus
	// input can never trigger credential-verification cost.
	if !ValidBotTokenShape(token) {
		http.Error(w, `{"error":"invalid bot token"}`, http.StatusUnauthorized)
		return
	}

	digest := BotTokenDigest(token)

	// Fast path: exact indexed match on the deterministic digest. This is the
	// normal authenticator for new and healed bots and performs no Argon2.
	var botUserID uuid.UUID
	err := db.QueryRow(r.Context(),
		`SELECT user_id FROM bots WHERE token_lookup = $1`, digest).Scan(&botUserID)
	if err == nil {
		authenticateBot(w, r, next, botUserID)
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		log.Error().Err(err).Msg("bot auth fast-path query failed")
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	// Transitional slow path: only legacy rows (never healed) whose stored hint
	// equals this token's suffix. The partial index on token_hint keeps this to
	// the tiny collision bucket -- normally one row -- instead of the table.
	suffix := token[len(token)-8:]
	rows, err := db.Query(r.Context(),
		`SELECT id, user_id, token_hash FROM bots WHERE token_lookup IS NULL AND token_hint = $1`,
		suffix)
	if err != nil {
		log.Error().Err(err).Msg("bot auth legacy query failed")
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}
	type legacyCandidate struct {
		id     uuid.UUID
		userID uuid.UUID
		hash   string
	}
	var candidates []legacyCandidate
	for rows.Next() {
		var c legacyCandidate
		if err := rows.Scan(&c.id, &c.userID, &c.hash); err != nil {
			rows.Close()
			log.Error().Err(err).Msg("bot auth legacy scan failed")
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}
		candidates = append(candidates, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		log.Error().Err(err).Msg("bot auth legacy rows error")
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	// Unknown hint (or no legacy rows left): no candidate, no Argon2, no oracle.
	if len(candidates) == 0 {
		http.Error(w, `{"error":"invalid bot token"}`, http.StatusUnauthorized)
		return
	}

	// One Argon2 permit for the whole request, taken only now that real
	// candidates exist and held across the candidate loop. Saturation means the
	// transitional Argon2 budget is momentarily full: a valid legacy credential
	// is throttled (429), not rejected as invalid (401).
	if !legacyArgon2Gate.tryAcquire() {
		w.Header().Set("Retry-After", "1")
		http.Error(w, `{"error":"bot authentication temporarily unavailable"}`, http.StatusTooManyRequests)
		return
	}
	defer legacyArgon2Gate.release()

	for _, c := range candidates {
		match, err := CompareBotToken(token, c.hash)
		if err == nil && match {
			// Lazy-heal: record the digest so this bot uses the fast path next
			// time. The token_lookup IS NULL guard makes concurrent first
			// authentications harmless no-ops instead of unique-index errors.
			// Healing is best-effort -- the credential is valid regardless.
			if _, err := db.Exec(r.Context(),
				`UPDATE bots SET token_lookup = $1 WHERE id = $2 AND token_lookup IS NULL`,
				digest, c.id); err != nil {
				log.Error().Err(err).Msg("bot token lazy-heal failed")
			}
			authenticateBot(w, r, next, c.userID)
			return
		}
	}

	http.Error(w, `{"error":"invalid bot token"}`, http.StatusUnauthorized)
}

func UserIDFromContext(ctx context.Context) uuid.UUID {
	uid, ok := ctx.Value(userIDKey).(uuid.UUID)
	if !ok {
		return uuid.Nil
	}
	return uid
}

// IsBotFromContext returns true if the request was authenticated via a Bot token.
func IsBotFromContext(ctx context.Context) bool {
	v, ok := ctx.Value(isBotKey).(bool)
	return ok && v
}
