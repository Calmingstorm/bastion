package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/alexedwards/argon2id"
	"github.com/google/uuid"
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

func handleBotAuth(w http.ResponseWriter, r *http.Request, next http.Handler, token string, db *pgxpool.Pool) {
	// Query all bot token hashes and match
	rows, err := db.Query(r.Context(),
		`SELECT b.user_id, b.token_hash FROM bots b`)
	if err != nil {
		log.Error().Err(err).Msg("failed to query bots for auth")
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var matchedUserID uuid.UUID
	found := false
	for rows.Next() {
		var botUserID uuid.UUID
		var tokenHash string
		if err := rows.Scan(&botUserID, &tokenHash); err != nil {
			continue
		}
		match, err := argon2id.ComparePasswordAndHash(token, tokenHash)
		if err == nil && match {
			matchedUserID = botUserID
			found = true
			break
		}
	}

	if !found {
		http.Error(w, `{"error":"invalid bot token"}`, http.StatusUnauthorized)
		return
	}

	ctx := context.WithValue(r.Context(), userIDKey, matchedUserID)
	ctx = context.WithValue(ctx, isBotKey, true)
	next.ServeHTTP(w, r.WithContext(ctx))
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
